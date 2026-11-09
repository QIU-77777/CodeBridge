#!/usr/bin/env node
/**
 * 前缀 id 的离线测试：不连飞书、不起后端，用桩配置构造 FeishuTransport，
 * 直接喂事件字段给 buildPrefix，断言协作要用的 id 一个不少。
 *
 *   node scripts/test-prompt-ids.mjs
 *
 * 背景（真实事故形态）：agent 在话题里要回复，得先拿到话题根消息的 om_ id，
 * 而前缀里只给了 thread id，剩下的只能去 logs/bridge.log 里翻。修法是把
 * chat / thread / root / msg / self 一次给全，并把 feishu.names 里声明的
 * 同伴 id（本应用视角）渲染成「可@的 id」一行。
 */
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const { FeishuTransport } = await import(`${REPO}src/feishu.js`)

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`❌ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}

const quiet = { info() {}, warn() {}, error() {} }

/** 造一个传输层实例。names 可覆盖，用于验证「没有同伴」与「自定义模板」两条路 */
function makeTransport({ names, templates } = {}) {
  const cfg = {
    feishu: {
      appId: 'cli_test',
      appSecret: 'secret',
      domain: 'feishu',
      requireMention: true,
      names: names === undefined ? { ou_human: '邱琪光', ou_peer: 'Lil_O' } : names,
    },
    prompt: { templates: templates || {} },
  }
  return new FeishuTransport(cfg, {
    onMessage() {},
    onCardAction() {},
    nameOf() {},
    backendType: 'pi',
    logger: quiet,
  })
}

const SELF = { open_id: 'ou_me', name: 'Lil_P' }
const WHEN = '1794223530000'

/** 话题内的一条消息：thread / root / msg 三 id 齐全 */
const threadMsg = {
  chat_id: 'oc_chat1',
  chat_type: 'group',
  thread_id: 'omt_thread1',
  root_id: 'om_root1',
  message_id: 'om_msg1',
  create_time: WHEN,
}

// ---------- 1. 话题内：五类 id 一个不少 ----------
{
  const t = makeTransport()
  const p = t.buildPrefix({
    m: threadMsg,
    self: SELF,
    userId: 'ou_human',
    isBot: false,
    chatName: '桥接话题探针',
    nick: '邱琪光',
    always: '',
  })
  ok(p.includes('chat oc_chat1'), '话题内：chat id', p)
  ok(p.includes('thread omt_thread1'), '话题内：thread id', p)
  ok(p.includes('root om_root1'), '话题内：root 消息 id（回复话题要用）', p)
  ok(p.includes('msg om_msg1'), '话题内：本条消息 id', p)
  ok(p.includes('self ou_me'), '话题内：自己的 open_id', p)
  ok(p.includes('群「桥接话题探针」'), '话题内：群名', p)
  ok(p.includes('话题内'), '话题内：位置描述', p)
  ok(p.includes('邱琪光 · ou_human'), '话题内：发送者名字+id', p)
  ok(!p.includes('ou_me=Lil_P'), '话题内：同伴列表不含自己', p)
  ok(p.includes('Lil_O=ou_peer'), '话题内：同伴 id 成对给出', p)
  ok(!/\{\{/.test(p), '话题内：没有未替换的占位符', p)
}

// ---------- 2. 主聊天流：只有 chat 与 msg，不出现 root ----------
{
  const t = makeTransport()
  const p = t.buildPrefix({
    m: { chat_id: 'oc_chat1', chat_type: 'group', root_id: '', message_id: 'om_msg2', create_time: WHEN },
    self: SELF,
    userId: 'ou_human',
  })
  ok(p.includes('chat oc_chat1') && p.includes('msg om_msg2'), '主聊天流：chat 与 msg', p)
  ok(!p.includes('root'), '主聊天流：没有 root 段', p)
  ok(!p.includes('thread'), '主聊天流：没有 thread 段', p)
  ok(p.includes('主聊天流'), '主聊天流：位置描述', p)
  ok(!/\{\{/.test(p), '主聊天流：没有未替换的占位符', p)
}

// ---------- 3. 私聊：只有 msg 与 self ----------
{
  const t = makeTransport()
  const p = t.buildPrefix({
    m: { chat_id: '', chat_type: 'p2p', message_id: 'om_msg3', create_time: WHEN },
    self: SELF,
    userId: 'ou_human',
  })
  ok(p.includes('msg om_msg3') && p.includes('self ou_me'), '私聊：msg 与 self', p)
  ok(!p.includes('chat '), '私聊：没有 chat 段', p)
  ok(p.includes('私聊'), '私聊：位置描述', p)
  ok(!/\{\{/.test(p), '私聊：没有未替换的占位符', p)
}

// ---------- 4. 拿不到自身 open_id：给「未知」而不是空占位 ----------
{
  const t = makeTransport()
  const p = t.buildPrefix({ m: threadMsg, self: { open_id: null, name: 'Lil_P' }, userId: 'ou_human' })
  ok(p.includes('self 未知'), '自身 id 缺失：显示未知', p)
  ok(!/\{\{/.test(p), '自身 id 缺失：没有未替换的占位符', p)
}

// ---------- 5. 没有 names：不输出同伴行 ----------
{
  const t = makeTransport({ names: {} })
  const p = t.buildPrefix({ m: threadMsg, self: SELF, userId: 'ou_human' })
  ok(!p.includes('可@'), '没有 names：不输出同伴行', p)
  ok(!/\{\{/.test(p), '没有 names：没有未替换的占位符', p)
}

// ---------- 6. 机器人发送者：senderType 走 bot ----------
{
  const t = makeTransport()
  const p = t.buildPrefix({ m: threadMsg, self: SELF, userId: 'ou_peer', isBot: true, nick: 'Lil_O' })
  ok(p.includes('（机器人）'), '机器人发送者：类型标注', p)
  ok(!p.includes('ou_peer=Lil_O') || p.includes('Lil_O=ou_peer'), '机器人发送者：同伴行照常', p)
}

// ---------- 7. 实例覆盖模板后仍能拿到全部变量 ----------
{
  const t = makeTransport({
    templates: {
      always: {
        ids: { thread: 'IDS c={{chat}} t={{thread}} r={{root}} m={{msg}} s={{self}} p={{peers}}' },
      },
    },
  })
  const p = t.buildPrefix({ m: threadMsg, self: SELF, userId: 'ou_human' })
  ok(
    p.includes('IDS c=oc_chat1 t=omt_thread1 r=om_root1 m=om_msg1 s=ou_me p=邱琪光=ou_human · Lil_O=ou_peer'),
    '自定义 ids 模板：全部变量可取',
    p,
  )
}

// ---------- 8. 自定义 always 前缀拼在最后 ----------
{
  const t = makeTransport()
  const p = t.buildPrefix({ m: threadMsg, self: SELF, userId: 'ou_human', always: '[自定义前缀]' })
  ok(p.endsWith('[自定义前缀]'), '自定义前缀拼在末尾', p)
  ok(p.split('\n').length === 5, '四行前缀 + 自定义前缀共五行', String(p.split('\n').length))
}

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
