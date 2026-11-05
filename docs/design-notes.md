# 实现笔记

面向要改代码、或者想知道「为什么这么做」的人。使用说明见 [README](../README.md)。

---

## 一、为什么不用现成的两个包

动手前试过两个现成方案，都不行。这一段是选型依据，不是产品说明。

### `@neomei/opencode-feishu`

它对外的说法是支持会话切换，实际实现是：

```
client.tui.selectSession(sessionId)
```

改的是 **opencode TUI 界面上的选中项**，不是「这个飞书聊天该用哪个会话」的映射。后果：

- 飞书点「切换」，电脑上 TUI 的高亮换了一行
- 飞书下次发消息，还是进原来那个会话
- `/new` 创建完新会话，映射关系压根没回写

会话绑定是这类工具的核心能力，不是锦上添花。切换不生效意味着两个任务的上下文会互相污染——这是正确性问题。

### `message-bridge-opencode-plugin`

切换是真的，但形态是 opencode plugin。装上撞 `fn3 is not a function`（[anomalyco/opencode#7792](https://github.com/anomalyco/opencode/issues/7792)），必须 clone 下来 `bun install` 走开发模式。而且依赖 plugin API，v2 的 plugin 架构换了（promise / effect adapter），兼容性没有保证。

### 判断标准

> 看它的「状态」存在哪里。状态存在自己手里的才可能做对，寄生在别人 UI 上的，随时会假。

方案 A 的状态存在 TUI 选中项里，所以切换必然是假的。方案 B 状态在服务端，方向对，但载体太脆。

本项目走 `opencode serve` 的 HTTP API，不碰 plugin API，也不碰 TUI。版本漂移只会影响这一层，而 HTTP 接口是最稳的一层。

---

## 二、飞书卡片 2.0 的坑（实测）

官方文档的组件表和实际 API 的接受度不完全一致。`scripts/probe-card.mjs` 把九种候选结构逐个真实发一遍，只看返回码：

| 候选结构 | 结果 |
| --- | --- |
| `div` + `lark_md` | 通过 |
| `markdown` 组件（含 `text_size`） | 通过 |
| `table` 组件 | 通过 |
| `column_set` | 通过 |
| 裸 `button` | 通过 |
| `hr` | 通过 |
| **`action` 容器** | **HTTP 400** |
| **`note` 组件** | **HTTP 400** |
| 1.0 与 2.0 互相 patch | **错误 200830** |

结论：

1. 卡片 2.0 **没有 `action` 容器**。按钮必须裸放进 `elements`；横排套 `column_set`，每列一个 `width: 'auto'` 的 column。
2. 卡片 2.0 **没有 `note` 组件**。小字用 `{tag: 'markdown', text_size: 'notation'}`。
3. 2.0 和 1.0 卡片**不能互相 patch**，报 `200830`。所以升级必须是全量的。

另外两条硬约束：

- 元素在 `body.elements`，**不是根级 `elements`**，且必须带 `schema: "2.0"`
- 单卡上限 30KB → 正文 `maxBodyChars`、表格最多 50 行 8 列

**方法论：平台文档和实际行为有偏差时，用最小成本的探针去问系统，不要靠读文档推理。** 那个探针脚本 60 行，换来后面没有一次盲试。

改卡片结构前先跑：

```bash
node scripts/probe-card.mjs          # 逐个组件真实发一遍，打印 ✅/❌
node scripts/test-cards.mjs --live   # 断言 + 真实发送 + patch
```

---

## 三、为什么 `lark_md` 渲染不了表格

飞书卡片的 `lark_md` 只是 Markdown 的**子集**：支持加粗、斜体、删除线、行内代码、链接、换行；**不支持表格、标题、代码块、列表**。

所以模型回一张 markdown 表格时，`| a | b |` 会被当成普通文字原样打出来。这不是开关问题，是那个字段本身没有这个能力——只有换成卡片 2.0 的 `table` 组件才能真渲染。

`src/md.js` 做分段扫描而不是逐行转换，因为表格是块级语法：必须看到下一行是不是 `| --- |` 分隔行，才能判断当前行是表头还是普通文字。凡是行与行之间有语法依赖的格式（表格、列表、引用块），都必须先分段再渲染。

降级规则：`## 标题` → 加粗，`- 项目` → `• 项目`，`> 引用` → 去符号。流式过程中半截表格先渲染成 `a ｜ b`，等分隔行写完再变成真表格，避免闪一下原始竖线。

---

## 四、消息为什么「只增不改」

第一版所有按钮结果都 patch 到当前卡片上。后果是：用户点一下「会话列表」，原来那张回答的卡片被顶掉，问题和答案一起消失。

修法是把回调返回分成两条路：

```
replyNew()  → 新发一条消息承载结果（绝大多数按钮）
replySelf() → 原地 patch 自己（只给自己翻页用）
```

流式更新是唯一例外——那是同一条消息的进度刷新。

`scripts/selftest.mjs` 里有断言守着这条：

```js
if (transport.patchedIds.includes('om_history')) {
  throw new Error('历史消息被 patch 覆盖了')
}
```

有回归测试守着，这个设计才不会被下一个「顺手优化」改回去。

## 五、回调返回体的坑（200672）

把结果卡片塞进 `card.action.trigger` 的返回体里，飞书直接报 **200672**。原因是返回值有严格 schema：`card` 字段必须是 `{type: 'raw', data: {...}}` 包装。

现在的做法是**回调只返回 toast，卡片一律走独立的发消息接口**：

```js
const replyNew = (toast, card) => {
  if (card) {
    setTimeout(() => {
      this.t.sendCard(chatId, card).catch(...)
    }, 250)
  }
  return { toast }
}
```

代价是多一次 HTTP、卡片晚 250ms。换来回调链路不再有格式问题。

---

## 六、状态与并发

### chat → session 映射是唯一真相来源

存在 `~/.config/opencode-feishu-bridge/state.json`：

```json
{ "chats": { "oc_xxx": { "sessionId": "ses_xxx", "directory": "/Users/you/project" } } }
```

为什么不问 opencode「当前活跃会话是哪个」？因为 v2 的 `/api/session/active` **只反映界面选中项**，不是「这个飞书聊天该用哪个」。而且 IM 天然多租户：一个私聊、一个群各自独立绑定，opencode 侧没有这个概念。

写入做了两件事：300ms 防抖（连续操作只落盘一次）、原子写（先写 `.tmp` 再 `rename`，避免进程被杀留下半个 JSON）。

单实例锁 `bridge.lock` 也是为了这个文件——两个进程同时写会互相覆盖，更糟的是同一条消息被回两遍。

### 看门狗（`idleTimeoutMs`）

事件流断了但进程还活着时，卡片会永远停在「执行中」。所以每分钟扫一遍所有 running 的 run，超过 `idleTimeoutMs` 没有 `updatedAt` 变化就标成失败、给出可读原因、收尾卡片。

### 并发保护

同一会话只能跑一个任务。上一条还在跑时新消息直接拒绝，不排队——排队的失败是静默的，用户不知道自己的话什么时候生效。

---

## 七、一个自己造成的运维事故

`up.sh` 起 `opencode serve` 时如果密码和配置里写的不一致，所有 API 都是 401，表现是「机器人收到消息但一直不说话」。

修法不是记性变好，而是让脚本自己读配置：

```bash
PW=$(node -e "console.log(require('$HOME/.config/opencode-feishu-bridge/config.json').opencode.password)")
OPENCODE_SERVER_PASSWORD="$PW" "$(node scripts/which-opencode.mjs)" serve --port 19876
```

`"$(node scripts/which-opencode.mjs)"` 拿到的和 `up.sh` 用的是同一份二进制。
不要手敲 `opencode`：PATH 里那份不一定是桌面版这一份，混起来会发生第八节那种事。

凡是「两份必须一致的东西」，就不该让人手工保持一致。

---

## 八、用哪个 opencode（版本一致性）

机器上可能同时有两套 opencode：

| 来源 | 路径 | 谁在用 |
|---|---|---|
| 桌面版自带 CLI | `~/Library/Application Support/ai.opencode.desktop/cli/<版本>-arm64/opencode-cli` | 桌面 App 自己 `serve --service`，跑在随机端口 |
| npm 全局 | `~/.npm-global/bin/opencode` | `npm i -g @opencode/cli` 装的，会遮住桌面版。**本机已卸载**，现在只剩桌面版一份 |

**它们写同一个数据库**：`~/.local/share/opencode/opencode.db`。用 `lsof` 能看到两个进程打开同一个 inode。

如果你机器上 `which opencode` 有输出，先把那份卸掉（`npm rm -g @opencode/cli`）。留着它不会立刻出错，但它会在某次 `npm i -g` 之后悄悄换版本，而两边共用数据库。

版本不一致时的故障不是「接口报错」，而是「数据读不出来」：新版本换了必填字段，旧版本写的行就解不出。2026-11 就踩过一次——compaction 记录缺 `recent`，整批会话发不出消息，错误却显示在桥接的卡片上，看着像桥接的锅（诊断步骤见第九节）。

### 字段是会来回增减的

那次事故之后把两个版本的 `Session.Message.Compaction.Completed` 都拉出来对了一遍，结论比「新版加字段」更麻烦——**字段在版本之间是双向增删的**：

```js
// v2.0.32
{ type:'compaction', status:'completed', reason, model?, providerState?,
  summary, recent: string,          // ← 必填，没有 .optional()
  providerContext?, cost?, tokens? }

// v2.2.5（从二进制里读出来的原文，压缩后变量名不同）
const p = { type:'compaction', ...common }
const M = { cost: optional, tokens: optional }
{ ...p, status:'completed', reason, model?, native?, summary, ...M }
//   ↑ 没有 recent，没有 providerState，没有 providerContext
```

2.2.5 把 `recent` 和 `providerContext` **删掉了**，新增了 `native`。

所以「按报错提示补字段」只是补当时那个版本的账：给 2.0.32 补上的 `recent`，到 2.2.5 已经是多余字段（宽松 schema 会忽略，所以补过的 10 条记录在 2.2.5 下依然能读——实测 5 个会话的 `/context` 全 200）。反过来，2.2.5 写的行如果带着 2.0.32 不认识的形状，拿 2.0.32 去读一样会挂。

这就是为什么不能靠「出问题再修数据」兜底：修完这轮，下一轮换个方向再来一遍。**写和读必须是同一份二进制**——这是下面那条决策的全部理由。

### 决策：优先用桌面版自带的 CLI

1. 桌面版和它的 CLI 是同一份代码，写出来的行一定读得回来
2. 桌面版升级时 CLI 跟着换，不会留下一个孤儿版本慢慢漂
3. 手机上派活的会话，桌面上直接能看到、能接着聊——因为确实是同一个库同一个服务端版本

不直接用桌面 App 那个 `serve --service` 实例：它用私有 token 认证，桥接不该去猜。桥接自己起一份，用配置里的密码。

### 实现

`src/which-opencode.js` 负责选二进制，优先级：

```
OPENCODE_BIN 环境变量  →  桌面版自带 CLI（版本号倒序取最新）  →  PATH 里的 opencode
```

第三档只是给「没装桌面版、自己另装了一份」的人留的，本机现在是空的（`which opencode` 无输出）。

桌面版升级后目录名里的版本号会变（`2.2.5-arm64` → `2.2.6-arm64`），所以按 `2.x.y` 数值倒序探测目录，不写死路径。`up.sh` 和 `doctor` 共用这一个模块，不用两边各写一份 shell 判断。

### 守卫：不一致要喊出来

`up.sh` 和 `npm run doctor` 都会比对「正在跑的 serve 版本」和「本地 CLI 版本」，不一致就告警。

不自动重启：重启 serve 会打断正在跑的任务，这种事不该在启动脚本里悄悄做。

### 升级流程

```bash
./scripts/down.sh
cp -p ~/.local/share/opencode/opencode.db{,.bak-$(date +%Y%m%d-%H%M%S)}
# 升级桌面版 / npm 包
./scripts/up.sh          # 打印选中的二进制和版本
npm run doctor           # 版本是否一致、模型是否还在
node scripts/test-cards.mjs
# 飞书里发一条测试消息
```

实测 2.0.32 → 2.2.5 这一跳，桥接用到的接口（`/api/session`、`/prompt`、`/model`、`/event` SSE 等）请求体和事件名都没变，升级后不需要改代码。

---

## 九、其他开发向排障

| 现象 | 原因 |
|---|---|
| 报 `Invalid URL` / `connect failed` | SDK 的 `domain` 传错。必须是 `Lark.Domain.Feishu` 枚举，不能是字符串 `'Feishu'`（会被当成 URL 前缀拼进请求路径） |
| 报 `200672` | 回调返回体里带了 `card` 字段，只允许返回 `{toast}` |
| 报 `200830` | 用旧版卡片 patch 一张 2.0 卡片（或反过来）。本项目卡片全是 2.0 |
| `Failed to decode message msg_xxx in session ses_xxx` | 见本节最后的「opencode 升级后的历史数据兼容问题」 |

### opencode 升级后的历史数据兼容问题

表现：某个会话突然发不出消息，卡片 1 秒内就失败，错误里带 `Failed to decode message … in session …`，而且每次都是同一个 `msg_id`。

原因不在桥接。opencode 的会话历史存在 `~/.local/share/opencode/opencode.db` 的 `session_message` 表里，每条记录是一个 JSON。v2.0.32 的 `Session.Message.Compaction.Completed` schema 长这样：

```js
{ type:'compaction', status:'completed', reason:enum('auto','manual'),
  model?: {...}, providerState?, summary: string,
  recent: string,                      // ← 必填，没有 .optional()
  providerContext?, cost?, tokens? }
```

有些记录是更早的版本写的，**没有 `recent` 字段**。opencode 在 `SessionRunner.drain → settleStaleToolCalls → SessionHistory.load` 读历史时解码失败，请求在走到模型之前就挂了，所以耗时永远不到 1 秒。

**先排除版本错配，再动数据。** 比对两个版本号：

```bash
curl -s -u "opencode:$PW" http://127.0.0.1:19876/api/info   # 正在跑的 serve
node scripts/which-opencode.mjs --json                       # 本地会用的那份
```

不一致时先 `./scripts/down.sh && ./scripts/up.sh` 换成同一份二进制，很多会话到这一步就自己能读了（读它的是写它的那个版本）。换完仍报同一个 `msg_id`，再往下修数据。

诊断：

```bash
sqlite3 ~/.local/share/opencode/opencode.db "
  select case when json_extract(data,'\$.recent') is null then '缺 recent' else 'ok' end k,
         count(*) from session_message where type='compaction' group by k;"
```

修复（先停 serve、先备份）：

```bash
./scripts/down.sh
cp -p ~/.local/share/opencode/opencode.db ~/.local/share/opencode/opencode.db.bak-$(date +%Y%m%d-%H%M%S)
sqlite3 ~/.local/share/opencode/opencode.db "
  BEGIN IMMEDIATE;
  UPDATE session_message SET data = json_set(data,'\$.recent','')
   WHERE type='compaction' AND json_valid(data)
     AND json_extract(data,'\$.recent') IS NULL;
  COMMIT;"
./scripts/up.sh
```

`recent` 是「保留原文的最近若干轮」，补空串是合法值（事件投影里本身就有 `recent: r.data.recent ?? ""`）。`summary` 不动，压缩摘要不丢。

验证：`GET /api/session/<id>/context` 返回 200 即恢复（这个接口走的就是 `SessionHistory.load`，和失败路径同一条）。

桥接这边做了兜底：卡片会把这段错误翻译成一句人话，并提示可以修数据或 `/new`。

**这条修复的保质期是「当时那个版本」。** 换到 2.2.5 之后复核：`recent` 在 2.2.5 的 schema 里已经不是字段了，多出来的键被忽略，那 10 条补过的记录照常能读（5 个会话 `/context` 全 200）。所以修数据只是把旧版本写的行迁就给它当时读它的那个版本；只要两个版本还在混用，下一轮会从另一个方向再坏一次。要根治得固定二进制来源——见第八节。

---

## 十、验证体系

| 层 | 手段 | 覆盖 |
|---|---|---|
| 组件级 | `scripts/probe-card.mjs` | 平台收不收这种结构 |
| 单元级 | `scripts/test-cards.mjs`（43 项） | Markdown 解析、卡片结构、大小、看门狗、错误提示、二进制选择 |
| 集成级 | `scripts/selftest.mjs`（23 项） | 真实建会话、真实 prompt、流式聚合、命令、回调、白名单 |
| 端到端 | `scripts/e2e-table.mjs` | 真实模型输出 → 真实事件流 → 真实卡片 |

`test-cards.mjs` 加 `--live` 会额外真实发送并 patch 一张卡片，多 3 项。

---

## 十一、文件

```
src/config.js    配置加载（文件 + 环境变量）
src/store.js     chat→session 绑定持久化（防抖 + 原子写）
src/oc.js        opencode v2 HttpApi 客户端 + SSE 订阅（指数退避重连）
src/render.js    事件 → 运行态聚合（文本、工具、状态机）
src/md.js        Markdown → 卡片元素（表格/代码块/标题/列表分段解析）
src/cards.js     飞书卡片模板（card 2.0）
src/handler.js   命令分发、消息处理、卡片回调、看门狗
src/feishu.js    飞书长连接与消息收发
src/index.js     入口（含 --dry 模式、单实例锁）
src/which-opencode.js  选哪个 opencode 二进制（桌面版 CLI 优先）

scripts/selftest.mjs    集成自测（23 项）
scripts/test-cards.mjs  卡片、markdown、看门狗、错误提示测试（43 项；--live 多 3 项）
scripts/doctor.mjs      环境体检（含版本一致性检查）
scripts/which-opencode.mjs  打印选中的二进制，供 up.sh 调用
scripts/probe-card.mjs  卡片 schema 探针
scripts/demo-card.mjs   发一张验收样式的卡片到飞书
scripts/e2e-table.mjs   端到端表格渲染验证
scripts/up.sh           起 serve + 起桥接，nohup 常驻，PID 落盘
scripts/down.sh         按 PID 停止两个进程
```

---

## 十二、后续方向

优先级按「补短板 / 提体验 / 扩形态」排，不按有趣程度排。

**P0**
1. **上下文引用（真正的多轮）**——现在每句话都是独立任务，「上面那个方案」没有指代对象。做法是把上一张卡片的结论摘要带进下一次 prompt，引用范围只取最近一张，并在卡片上标注「已引用上一条结论」。
2. **执行前计划审批**——权限卡片已有 `once / always / reject` 三态基建，缺的是从「工具级」提到「计划级」：模型先出计划，人点通过再执行。这解决的是信任问题，优先级应高于任何功能新增。
3. **失败自恢复**——错误分类（网络 / 模型不可用 / 会话丢失 / 权限不足），每类给一条明确的下一步操作，而不是把原始堆栈丢给人。

**P1**
4. 轨迹按需展开（默认折叠，点一下看最近 6 个工具调用摘要）
5. 成本拦截而不只是展示（超预算中止、每日汇总）
6. 卡片内直接选模型与 Agent（`POST /api/session/:id/model` 字段够了，缺交互组件）
7. 文件与图片输入（`im.v1.messageResource.get` 下载落盘 → prompt 的 `files` 字段）

**P2**
8. 多人协作，但反着做：默认每人私有绑定（按 `open_id` 二级映射），共享会话作为显式开关，高危操作需绑定者确认
9. 任务队列（公平调度 + 优先级 + 过期清理）
10. 多 IM 适配层（`sendCard / patchCard / sendText` 抽成 transport）。代价是卡片能力退化到各平台交集，所以等第二个平台真要接时再做
11. 官方 plugin 形态（等 v2 plugin 架构稳定；在那之前独立进程更稳，不依赖宿主）

**明确不做**：云端执行沙箱、IDE 替代、团队级权限与审计。
