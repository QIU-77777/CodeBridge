#!/usr/bin/env node
/**
 * 登录流程的离线测试：不连服务、不碰真凭据。
 *   node scripts/test-oar-login.mjs
 *
 * 用一个假运行时驱动 OAR 的 login 交互面，断言 LoginFlow 的状态迁移，以及
 * 卡片按状态渲染出的内容。用户的回执码走 flow.answer，不进卡片。
 */
import { LoginFlow } from '../src/oar-login.js'
import { loginCard } from '../src/cards.js'

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

const INSTALL = { kind: 'available', via: 'bundled' }

/** 卡片正文拉平成文本，方便断言 */
function cardText(card) {
  return JSON.stringify(card)
}

/**
 * 造一个假运行时：login 按脚本驱动交互面。
 * @param {(i: object) => Promise<object>} script 收到 interaction，返回 LoginResult
 */
function fakeRuntime(script) {
  return { id: 'kimi', brand: { name: 'Kimi Code', icon: null }, login: async (installation, interaction, options) => script(interaction, installation, options) }
}

// ---------- 1. 设备码流程 ----------

{
  const states = []
  const flow = new LoginFlow({
    runtime: fakeRuntime(async (i) => {
      i.onEvent({ kind: 'auth_url', url: 'https://example.com/authorize', instructions: '在浏览器里完成' })
      i.onEvent({ kind: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device', expiresInSeconds: 600, intervalSeconds: 5 })
      const code = await i.prompt({ kind: 'manual_code', message: '把页面显示的回执码发到群里' })
      if (code === '') return { kind: 'cancelled' }
      return { kind: 'logged_in', account: { email: 'a@b.c' } }
    }),
    installation: INSTALL,
    onState: (s) => states.push(s.phase),
  })
  const p = flow.start()
  // 等状态走到等待回答
  for (let i = 0; i < 50 && !flow.awaitingText; i++) await new Promise((r) => setTimeout(r, 10))
  ok(flow.awaitingText === true, '等到需要回答时 awaitingText 为 true')
  ok(flow.state.phase === 'prompt', '状态停在等待回答', flow.state.phase)
  ok(flow.state.url === 'https://example.com/device', '设备码的验证地址覆盖掉授权地址', flow.state.url)
  ok(flow.state.userCode === 'ABCD-1234', '用户码带出来', flow.state.userCode)
  ok(flow.state.expiresInSeconds === 600, '有效期带出来', String(flow.state.expiresInSeconds))

  const card = loginCard(flow.state, { label: 'Kimi Code', k: 'root:om_1', rt: 'om_1' })
  const text = cardText(card)
  ok(text.includes('https://example.com/device'), '卡片显示验证地址')
  ok(text.includes('ABCD-1234'), '卡片显示用户码')
  ok(text.includes('回执码'), '卡片说明要把回执码发到群里')
  ok(text.includes('取消登录'), '卡片有取消按钮')
  ok(!text.includes('a@b.c'), '卡片不显示账号（还没登录）')

  ok(flow.answer('MY-RECEIPT-CODE') === true, '回答被接受')
  const result = await p
  ok(result.kind === 'logged_in', '登录成功', JSON.stringify(result))
  ok(flow.state.phase === 'done', '状态到完成', flow.state.phase)
  const doneCard = cardText(loginCard(flow.state, { label: 'Kimi Code' }))
  ok(doneCard.includes('a@b.c'), '完成卡片显示账号', doneCard.slice(0, 200))
  ok(!doneCard.includes('取消登录'), '完成卡片没有取消按钮')
}

// ---------- 2. 选项提问 ----------

{
  const flow = new LoginFlow({
    runtime: fakeRuntime(async (i) => {
      const pick = await i.prompt({
        kind: 'select',
        message: '选一个登录方式',
        options: [
          { id: 'oauth', label: '账号登录', description: '浏览器授权' },
          { id: 'api_key', label: 'API 密钥', description: '粘贴密钥' },
        ],
      })
      return pick === 'oauth' ? { kind: 'logged_in' } : { kind: 'failed', reason: 'rejected', detail: '密钥无效' }
    }),
    installation: INSTALL,
  })
  const p = flow.start()
  for (let i = 0; i < 50 && flow.state.phase !== 'prompt'; i++) await new Promise((r) => setTimeout(r, 10))
  ok(flow.state.prompt?.kind === 'select', '选项提问归一成 select', JSON.stringify(flow.state.prompt))
  ok(flow.state.prompt.options.length === 2, '两个选项', JSON.stringify(flow.state.prompt.options))
  ok(flow.awaitingText === false, '选项提问不等文本，走按钮', String(flow.awaitingText))

  const card = cardText(loginCard(flow.state, { label: 'Kimi Code' }))
  ok(card.includes('账号登录') && card.includes('API 密钥'), '卡片渲染选项按钮')
  ok(card.includes('login-answer'), '选项按钮带 login-answer 动作')
  ok(card.includes('"v":"oauth"'), '按钮带上选项 id')

  ok(flow.answer('api_key') === true, '选项答案被接受')
  const r = await p
  ok(r.kind === 'failed' && r.detail === '密钥无效', '失败结果带回原因', JSON.stringify(r))
  ok(cardText(loginCard(flow.state, {})).includes('密钥无效'), '失败卡片显示原因')
}

// ---------- 3. 取消与异常 ----------

{
  const flow = new LoginFlow({
    runtime: fakeRuntime(async (i) => {
      i.onEvent({ kind: 'auth_url', url: 'https://example.com/x' })
      await new Promise((resolve) => {
        i.signal.addEventListener('abort', resolve)
      })
      return { kind: 'cancelled' }
    }),
    installation: INSTALL,
  })
  const p = flow.start()
  await new Promise((r) => setTimeout(r, 30))
  flow.cancel()
  const r = await p
  ok(r.kind === 'cancelled', '取消后结果是 cancelled', JSON.stringify(r))
  ok(cardText(loginCard(flow.state, {})).includes('本机凭据没有变化'), '取消卡片说明凭据没动')

  // 后端抛错：不当成挂住，回一句失败
  const flow2 = new LoginFlow({
    runtime: fakeRuntime(async () => {
      throw new Error('登录进程起不来')
    }),
    installation: INSTALL,
  })
  const r2 = await flow2.start()
  ok(r2.kind === 'failed' && r2.detail === '登录进程起不来', '后端抛错归一成失败', JSON.stringify(r2))

  // 没有 login 接口：明说不支持，不挂住
  const flow3 = new LoginFlow({ runtime: { id: 'x', brand: { name: 'x' } }, installation: INSTALL })
  const r3 = await flow3.start()
  ok(r3.kind === 'unsupported', '没有登录接口时报不支持', JSON.stringify(r3))
  ok(cardText(loginCard(flow3.state, {})).includes('不支持在桥接里登录'), '不支持时说清')
}

// ---------- 4. 只认当前提问，避免串答 ----------

{
  const flow = new LoginFlow({
    runtime: fakeRuntime(async (i) => {
      await i.prompt({ kind: 'text', message: '第一个问题' })
      await i.prompt({ kind: 'text', message: '第二个问题' })
      return { kind: 'logged_in' }
    }),
    installation: INSTALL,
  })
  const p = flow.start()
  for (let i = 0; i < 50 && !flow.awaitingText; i++) await new Promise((r) => setTimeout(r, 10))
  ok(flow.answer('第一答') === true, '第一个回答被接受')
  for (let i = 0; i < 50 && flow.state.prompt?.message !== '第二个问题'; i++) await new Promise((r) => setTimeout(r, 10))
  ok(flow.state.prompt?.message === '第二个问题', '第二个提问跟上', JSON.stringify(flow.state.prompt))
  ok(flow.answer('第二答') === true, '第二个回答被接受')
  ok((await p).kind === 'logged_in', '两问之后登录成功')
  ok(flow.answer('迟到的回答') === false, '没有等待中的提问时回答被拒')
}

console.log()
if (fail) {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
}
