/**
 * 探针：把候选卡片结构真实发给飞书，验证 schema 2.0 各组件是否被接受。
 * 用法：node scripts/probe-card.mjs
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { loadConfig } from '../src/config.js'

const cfg = loadConfig()
const CHAT_ID = process.env.PROBE_CHAT || 'oc_6603cd2922863fd16081b7fc1d9d08f0'

const client = new Lark.Client({
  appId: cfg.feishu.appId,
  appSecret: cfg.feishu.appSecret,
  domain: cfg.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.warn,
})

const base = (elements, extra = {}) => ({
  schema: '2.0',
  config: { update_multi: true, ...extra },
  header: { template: 'blue', title: { tag: 'plain_text', content: '探针' } },
  body: { elements },
})

const cases = {
  '2.0/div-lark_md': base([{ tag: 'div', text: { tag: 'lark_md', content: '**加粗** 普通' } }]),

  '2.0/markdown-组件': base([
    { tag: 'markdown', content: '```js\nconst a = 1\n```' },
  ]),

  '2.0/markdown-text_size': base([
    { tag: 'markdown', content: '小字备注', text_size: 'notation' },
  ]),

  '2.0/table-组件': base([
    {
      tag: 'table',
      page_size: 5,
      row_height: 'low',
      header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', bold: true, lines: 1 },
      columns: [
        { name: 'c0', display_name: '名称', data_type: 'lark_md', horizontal_align: 'left', width: 'auto' },
        { name: 'c1', display_name: '值', data_type: 'lark_md', horizontal_align: 'left', width: 'auto' },
      ],
      rows: [
        { c0: 'a', c1: '1' },
        { c0: 'b', c1: '2' },
      ],
    },
  ]),

  '2.0/action-容器': base([
    {
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '按钮A' }, type: 'primary', value: { a: 'noop' } },
      ],
    },
  ]),

  '2.0/button-裸放': base([
    { tag: 'button', text: { tag: 'plain_text', content: '裸按钮' }, type: 'primary', value: { a: 'noop' } },
  ]),

  '2.0/hr': base([{ tag: 'hr' }]),

  '2.0/note-组件': base([{ tag: 'note', elements: [{ tag: 'plain_text', content: '备注' }] }]),

  '2.0/column_set': base([
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        { tag: 'column', width: 'weighted', weight: 5, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '左' } }] },
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '右' }, type: 'default', value: { a: 'noop' } }] },
      ],
    },
  ]),
}

async function send(name, card) {
  try {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: CHAT_ID, msg_type: 'interactive', content: JSON.stringify(card) },
    })
    const ok = res?.code === 0
    console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `  code=${res?.code} msg=${res?.msg}`}`)
    return { name, ok, code: res?.code, msg: res?.msg, id: res?.data?.message_id }
  } catch (e) {
    console.log(`❌ ${name}  抛错 ${e.message}`)
    return { name, ok: false, err: e.message }
  }
}

const results = []
for (const [name, card] of Object.entries(cases)) {
  results.push(await send(name, card))
  await new Promise((r) => setTimeout(r, 400))
}

console.log('\n--- 汇总 ---')
console.log(JSON.stringify(results, null, 2))
