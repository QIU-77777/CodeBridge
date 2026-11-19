#!/usr/bin/env node
/**
 * 飞书宿主工具的离线测试：不起飞书连接，用假传输层。
 *   node scripts/test-oar-host-tools.mjs
 *
 * 两层：
 *   1. 工具本身：feishuHostTools 造出来的三个工具，handler 直接调
 *   2. 过 MCP：serveFeishuTools 起真服务器，用 JSON-RPC 走一遍 tools/list 与
 *      tools/call，证明运行时挂上来时看到的就是这套
 */
import { feishuHostTools, serveFeishuTools } from '../src/oar-host-tools.js'

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}

/** 假传输层：记下每次发送 */
function fakeTransport() {
  const sent = []
  return {
    sent,
    async sendText(chatId, text, opts = {}) {
      sent.push({ kind: 'text', chatId, text, replyTo: opts.replyTo || null })
      return `om_sent_${sent.length}`
    },
    async sendCard(chatId, card, opts = {}) {
      sent.push({ kind: 'card', chatId, card, replyTo: opts.replyTo || null })
      return `om_card_${sent.length}`
    },
  }
}

const toolOf = (tools, name) => tools.find((t) => t.name === name)

// ---------- 1. 没有传输层就没有工具 ----------

{
  const tools = feishuHostTools({ transport: null })
  ok(tools.length === 0, '没有传输层时不起工具（不挂一个空服务器）')
}

// ---------- 2. send_message ----------

{
  const t = fakeTransport()
  const tools = feishuHostTools({ transport: t })
  const send = toolOf(tools, 'send_message')
  ok(Boolean(send), '有 send_message 工具')
  ok(send.annotations?.destructiveHint === false, 'send_message 声明为非破坏性')
  ok(send.inputSchema.required.includes('chat_id') && send.inputSchema.required.includes('text'), '输入契约要求 chat_id 与 text')

  const r = await send.handler({ chat_id: 'oc_a', text: '跑完了，结论是 X' })
  ok(String(r).includes('om_sent_1'), '发送成功带回消息 id', String(r))
  ok(t.sent[0].chatId === 'oc_a' && t.sent[0].text === '跑完了，结论是 X', '内容与目标都对', JSON.stringify(t.sent[0]))

  const r2 = await send.handler({ chat_id: 'oc_a', text: '接着这个话题说', reply_to: 'om_root' })
  ok(t.sent[1].replyTo === 'om_root', '带 reply_to 就落到同一话题下', JSON.stringify(t.sent[1]))

  const bad = await send.handler({ chat_id: '', text: '' })
  ok(bad?.isError === true, '参数不全时报错而不是瞎发', JSON.stringify(bad))
}

// ---------- 3. list_chats ----------

{
  const store = {
    all: () => [
      { key: 'root:om_1', chatId: 'oc_a', directory: '/tmp/proj', sessionId: 'ses_1' },
      { key: 'oc_b', chatId: 'oc_b', directory: '', sessionId: null },
    ],
  }
  const tools = feishuHostTools({ transport: fakeTransport(), store })
  const list = toolOf(tools, 'list_chats')
  ok(list.annotations?.readOnlyHint === true, 'list_chats 声明为只读')
  const r = await list.handler({})
  ok(r.includes('root:om_1') && r.includes('oc_a') && r.includes('/tmp/proj'), '列出绑定键、会话 id 与目录', r)
  ok(r.includes('未绑定'), '没绑会话的说未绑定', r)

  const empty = await toolOf(feishuHostTools({ transport: fakeTransport(), store: { all: () => [] } }), 'list_chats').handler({})
  ok(empty.includes('还没有任何会话绑定'), '没有绑定时说清', empty)

  const none = await toolOf(feishuHostTools({ transport: fakeTransport() }), 'list_chats').handler({})
  ok(none.includes('没有可列的会话'), '没有存储时说清', none)
}

// ---------- 4. ask_human ----------

{
  let asked = null
  const askHuman = async (scope, question, timeoutMs) => {
    asked = { scope, question, timeoutMs }
    return '用方案 A'
  }
  const tools = feishuHostTools({ transport: fakeTransport(), askHuman })
  const ask = toolOf(tools, 'ask_human')
  ok(Boolean(ask), '给了 askHuman 实现才有 ask_human 工具')
  const r = await ask.handler({ chat_id: 'oc_a', question: '选 A 还是 B？' })
  ok(r === '用方案 A', '回答原样返回给模型', String(r))
  ok(asked.scope === 'chat:oc_a|thread:' && asked.question === '选 A 还是 B？', '作用域与问题传对了', JSON.stringify(asked))
  ok(asked.timeoutMs === 300_000, '默认等 5 分钟', String(asked.timeoutMs))

  // 给了 thread_id 就问在那个话题下，只收那一处的回答
  await ask.handler({ chat_id: 'oc_a', question: '在话题里问', thread_id: 'om_root_1' })
  ok(asked.scope === 'chat:oc_a|thread:om_root_1', '给了 thread_id 就限定到那个话题', JSON.stringify(asked))

  await ask.handler({ chat_id: 'oc_a', question: '快点', timeout_ms: 60_000 })
  ok(asked.timeoutMs === 60_000, '超时可调', String(asked.timeoutMs))
  await ask.handler({ chat_id: 'oc_a', question: '太久', timeout_ms: 99_999_999 })
  ok(asked.timeoutMs === 3_600_000, '超时上限一小时，不给无限等', String(asked.timeoutMs))

  const timeoutAnswer = await toolOf(
    feishuHostTools({ transport: fakeTransport(), askHuman: async () => null }),
    'ask_human',
  ).handler({ chat_id: 'oc_a', question: '有人吗' })
  ok(timeoutAnswer?.isError === true, '超时告诉模型没人回答，不返回空串', JSON.stringify(timeoutAnswer))

  ok(toolOf(feishuHostTools({ transport: fakeTransport() }), 'ask_human') === undefined, '没给 askHuman 实现就没有这个工具')
}

// ---------- 5. 过 MCP：起真服务器走一遍 ----------

{
  const t = fakeTransport()
  const served = await serveFeishuTools({ transport: t, store: { all: () => [] }, askHuman: async () => '好' })
  ok(Boolean(served), '服务器起得来')
  const { server } = served
  ok(server.type === 'http', '给运行时的条目是 http', server.type)
  ok(server.url.startsWith('http://127.0.0.1:'), '只监听本机回环', server.url)
  ok(Boolean(server.headers?.Authorization), '带 bearer 令牌', JSON.stringify(server.headers))

  const call = async (body) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: server.headers.Authorization },
      body: JSON.stringify(body),
    })
    return res.json()
  }

  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  ok(Boolean(init.result), 'initialize 通', JSON.stringify(init).slice(0, 120))
  ok(typeof init.result.instructions === 'string' && init.result.instructions.length > 0, '带工具组说明', String(init.result.instructions).slice(0, 80))

  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const names = (list.result?.tools || []).map((x) => x.name).sort()
  ok(names.join(',') === 'ask_human,list_chats,send_message', 'tools/list 给出三个工具', names.join(','))

  const send = await call({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'send_message', arguments: { chat_id: 'oc_a', text: '从 MCP 发的' } },
  })
  ok(!send.result?.isError, '过 MCP 发送成功', JSON.stringify(send.result).slice(0, 160))
  ok(t.sent[0]?.text === '从 MCP 发的', '过 MCP 的内容真的发出去了', JSON.stringify(t.sent[0]))

  const unknown = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: '不存在的工具', arguments: {} } })
  ok(Boolean(unknown.error), '调不存在的工具报 JSON-RPC 错', JSON.stringify(unknown).slice(0, 120))

  const noAuth = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
  })
  ok(noAuth.status === 401 || noAuth.status === 403, '没有令牌进不来', String(noAuth.status))

  await served.close()
  const afterClose = await fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization } }).catch(() => null)
  ok(afterClose === null || afterClose.status >= 400, '关掉之后服务器不再应答')
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
