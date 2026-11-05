/**
 * 给飞书发一张「真实回复样式」的示范卡片，用于肉眼验收表格/代码块渲染。
 * 用法：node scripts/demo-card.mjs
 */
import { loadConfig } from '../src/config.js'
import { FeishuTransport } from '../src/feishu.js'
import { RunState } from '../src/render.js'
import { runCard } from '../src/cards.js'

const cfg = loadConfig()
const chatId = process.env.PROBE_CHAT || 'oc_6603cd2922863fd16081b7fc1d9d08f0'

const st = new RunState('ses_demo')
st.status = 'done'
st.steps = 3
st.cost = 0.0184
st.tokens = { input: 1832, output: 421 }
st.text = `表格现在走飞书卡片 2.0 的原生 table 组件，不再是一坨竖线了。

## 改造点

| 元素 | 改造前 | 改造后 |
| --- | --- | --- |
| 表格 | lark_md 里塞竖线，渲染成 raw 文本 | 原生 table 组件，可翻页可对齐 |
| 代码块 | 挤在段落里，没有高亮 | markdown 组件，带语法高亮 |
| 标题 \`## x\` | 原样显示 ## | 自动降级为加粗 |
| 无序列表 \`- x\` | 原样显示短横线 | 自动转成圆点 |

## 代码块效果

\`\`\`js
// 表格被识别成 table 组件的判断
if (isRow(line) && isSeparator(next)) {
  out.push(buildTable(header, rows))
}
\`\`\`

## 列表效果

- 第一条：结论文本正常渲染
- 第二条：工具调用链路已默认关闭
- 第三条：需要看轨迹请到电脑上的 opencode

普通段落和**加粗**、\`行内代码\`、[链接](https://opencode.ai) 照旧支持。`

const transport = new FeishuTransport(cfg, { onMessage: async () => {}, onCardAction: async () => ({}) })
const card = runCard(st, {
  directory: cfg.opencode.defaultDirectory,
  model: cfg.opencode.defaultModel || 'provider/model',
  title: '渲染验收 · 卡片 2.0',
  maxBodyChars: 6000,
  showTools: false,
  // 这张是发到群里的（PROBE_CHAT 是 oc_ 开头的群），后缀要用群版文案，
  // 不然验收时会看到「发送 /help」而以为线上也长这样。
  isGroup: true,
  ...(process.env.PROBE_ROOT ? { key: `root:${process.env.PROBE_ROOT}`, rootId: process.env.PROBE_ROOT } : {}),
})

const id = await transport.sendCard(chatId, card)
console.log('已发送 message_id =', id)
process.exit(0)
