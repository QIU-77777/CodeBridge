# 话题近况（同话题上下文补齐）需求规格

> 状态：已实现、已归档
> 日期：2026-11-11
> 交付提交：`1e9dad0`
> 关联实现笔记：[design-notes.md 第十四节](design-notes.md)
> 适用范围：飞书 ⇄ 本地 Agent 桥接（opencode / pi 两个后端通用）

---

## 1. 需求上下文

需求来自一次对现状的追问，不是凭空加功能。用户在讨论「上下文引用（跨会话失忆）」时把话题拉回同话题内：

> 现在同一话题下的消息（又分为 @ 我和没 @ 我的）中只有 @ 我的会进入到同一个会话吗，如果我前面有很多跟别人讨论，但是没有 @ 我，它其实是不知情的，只能通过自己调命令去翻聊天记录，是吗

核对代码后确认属实：群消息只有 @ 本机器人（`mentions[]` 含自身 `open_id`）才触发执行；其余消息在 `src/feishu.js` 的 @ 闸门处 `return`，连日志都不记。模型若要知道前期讨论，只能按 `prompts.json` 协作规则第 2 条的指引自己跑 `feishu-cli msg thread-messages` 拉历史——每次都要花若干步工具调用，且模型未必能判断「自己不知情」。

**边界澄清**：本需求解决的是「同一话题内没 @ 我的轮次模型看不到」（话题内盲区）。design-notes 十三节 P0 第 1 项的「跨会话失忆」（新话题 / `/new` 之后「上面那个方案」没有指代对象）是另一件事，仍待做，不在本规格范围。

---

## 2. 现状与问题

| 事实 | 出处 |
|---|---|
| 飞书把群里每条 `im.message.receive_v1` 都推给在群的每个机器人 | design-notes 十二节实测 |
| 桥接在 `mentions[]` 找不到自身 `open_id` 时直接 `return` | `src/feishu.js` @ 闸门 |
| 话题绑定键 `root:<话题根>`，话题内 @ 我的消息进同一 opencode 会话 | design-notes 十二节、`ctxOf()` |
| 主聊天流里 @ 我的每条消息都是新会话（键是自身 `message_id`） | `ctxOf()` / `src/feishu.js` |
| 模型被明确告知自己收不到没 @ 的轮次，并被要求按需拉历史 | `prompts.json` `once.rules` 第 2 条（本需求前） |

**问题本质**：数据本来就在手上（事件已到达进程），是在闸门处被丢掉，而不是需要去远端取。闸门本身是对的（design-notes 十二节：多机器人同群时「谁会被唤醒必须是显式的」，隐式订阅会造成五倍噪声），不能为了补上下文去放开它。

**影响面**：所有群聊场景的私有上下文；多 agent 协作话题尤甚——人类与别的 agent 的讨论全在盲区里。私聊不受影响（无 @ 闸门，每条消息都进会话）。

---

## 3. 目标与非目标

**目标**
- G1 被 @ 唤醒时，模型直接看到该话题最近若干条没 @ 它的轮次原文，不需要先跑工具调用拉历史。
- G2 不改变 @ 闸门的唤醒语义：没 @ 的消息仍不触发执行、不建 run、不进会话。
- G3 成本可控、可关闭：单次注入有硬上限，配置可关。
- G4 对两个后端（opencode / pi）、排队消息、私聊都行为一致。

**非目标**
- 不做跨会话引用（新话题 / `/new` 之后接上一条结论）。
- 不做计划审批（P0 第 2 项）。
- 不把卡片展开成正文、不做图片/文件 OCR。
- 不做持久化缓冲（重启后更早的历史仍靠 `feishu-cli`）。
- 不引入任何模型调用来做压缩或摘要。

---

## 4. 决策记录

用户在需求讨论中给了三条参考意见：「带 N 轮原始消息而不是摘要（做摘要也要模型拿原文总结一次，总 input 更多）」「什么消息类型，text 还是 post 都要给」「主聊天流 / 私聊的上下文怎么带、带哪些」。判断权归实现方，最终决策如下。

| # | 议题 | 决策 | 理由 |
|---|---|---|---|
| D1 | 摘要 vs 原文 | **原始消息** | 用户的成本论成立，且更硬的一条理由：桥接里没有 LLM，做摘要要为一件辅助的事起一次完整后端 run——总 input 变「原文 + 摘要」两份，还引入延迟和新的失败链路。用两级截断（单条 400 字 / 总量 2500 字保尾）兜住成本。协作场景里对方轮次的原话（命令、参数、路径、措辞）正是模型要用的东西，摘要会磨掉 |
| D2 | 消息类型 | **text + post 都给**，其余给占位符 | text 按主路径还原 `@_user_1` 占位符为 `@姓名`；post 富文本按段拉平（text 取文字、a 取链接文字、at 按 user_id 去 mentions 找名字）。图片/文件/语音/视频/卡片给一行 `[图片]` 类占位——模型至少知道「谁在什么时刻发了什么类型」，需要细节自己拉。卡片不展开：别的 agent 的卡片可能很大，且格式不是文字 |
| D3 | 话题内 | 按 `root:<root_id>` 缓冲 | 与会话绑定键同语义，话题之间天然隔离；引用回复链（主聊天流里带 `root_id`）同样归此键 |
| D4 | 主聊天流 | 按 `chat:<chat_id>` 缓冲 | 主聊天流每次 @ 都是新会话（绑定键是自身 `message_id`），话题近况是它唯一的上下文来源。若按 root 建桶会变成「一条消息一个桶，桶里永远只有它自己」 |
| D5 | 私聊 | **不采集、不带** | 私聊无 @ 闸门，每条消息本来就进会话；带了是重复 input |
| D6 | 已 @ 过我的轮次 | 只给指针行 `→ [19:55] 名字: <前40字>…（已 @ 我）` | 正文已作为 prompt 进会话历史，整段重给是双倍 input；指针行保住的是时间线交错——模型能看出讨论发生在自己被唤醒那次之后 |
| D7 | 自己的消息 | 不进缓冲 | 模型知道自己说过什么；卡片回流事件记进去等于制造上下文循环 |
| D8 | 当前这条 | 快照排除自身 | 它就是本次 prompt，重给是重复 |
| D9 | 采集点 | **@ 闸门之前** | 没 @ 的轮次正是要留的。位置反了功能就没了；此顺序由集成测试守住 |
| D10 | 名字 | 取不到给完整 `open_id` | `@` 回去需要完整 id，截断就 @ 不回去（同「可@的 id」行原则） |
| D11 | 缓冲 | 内存 `TopicLog`，单桶 60 条 / 最多 128 桶 | 覆盖「最近几条」；长刷屏话题不无限膨胀，进一堆群不撑爆内存。重启即失可接受 |

---

## 5. 需求清单（可验收）

| 编号 | 需求 |
|---|---|
| FR-1 | 群消息（含没 @ 我的）在进入 @ 闸门之前被采集；`@` 闸门语义不变，没 @ 的不触发 `onMessage` |
| FR-2 | 唤醒时把本上下文最近 N 条原文随 prompt 发送，排除当前消息自身 |
| FR-3 | 话题内按 `root:<根>`、主聊天流按 `chat:<群>` 分桶，互不串扰 |
| FR-4 | 私聊不采集、不带近况；机器人自己发出的消息不进缓冲 |
| FR-5 | text 占位符还原；post 按段拉平；非文本给类型占位符；空内容/非法 JSON 不进缓冲 |
| FR-6 | 已 @ 过我的轮次渲染为指针行，不重复给全文 |
| FR-7 | 两级截断：单条 400 字、指针行 40 字、总量 `topicContextChars` 保尾并注明省略条数 |
| FR-8 | 提示词文案全部外置 `prompts.json`；协作规则改为「先读近况块，不够再拉历史」 |
| FR-9 | 开关 `behavior.topicContext`（默认 `true`）、条数 `topicContextMessages`（20）、字数 `topicContextChars`（2500） |
| FR-10 | 排队消息带入队时的快照；outcome 与 opencode / pi 两个后端一致（同一条 `runPrompt` 链路） |

---

## 6. 验收标准

`node scripts/test-topic-context.mjs`（52 项，全部通过），对应：

| 验收点 | 覆盖 |
|---|---|
| FR-1 / D9 | FeishuTransport 离线集成：stub `client.request`，喂「两条没 @ + 一条 @ 我」，断言只触发一次 `onMessage`、两条原文都在近况里 |
| FR-2 / D8 | 断言当前消息文本不出现在近况块 |
| FR-3 / D4 / D5 | 话题隔离、主聊天流按群聚、私聊不带、别的 root 不串扰 |
| FR-4 / D7 | 自己的 `interactive` 消息不产生 `[卡片]` 行 |
| FR-5 / D2 | text/post 拉平、占位符还原、占位标签、非法输入、非文本类型 |
| FR-6 / D6 | 指针行前缀、后缀、40 字截断 |
| FR-7 | 400 字截断、总量保尾 + 「更早的 N 条已省略」 |
| FR-9 | `topicContext=false` 时不带近况 |
| FR-10 | Bridge 断言 `prompt` 拼装顺序「来源→规则→近况→正文」、后续消息不重复 once 规则、排队条目带快照 |

**回归**（全部离线通过）：test-cards 166 / test-pi 143 / test-admin 161 / test-busy 42 / test-errors 48 / test-admin-api 44 / test-up-sh 27 / test-patch-order 29 / test-session-seq 22 / test-runfail 11 / test-render 12 / test-wedge 9 / test-cmd-route 9 / test-prompt-ids 39。

`selftest` 需要真实 serve，未纳入本次离线验收；上线前在飞书群里发一条「前面有人讨论过、没 @ 我」的真实话题消息做端到端确认。

---

## 7. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `behavior.topicContext` | `true` | 关掉即完全不采集、不注入 |
| `behavior.topicContextMessages` | `20` | 最多带几条（按时间取最近） |
| `behavior.topicContextChars` | `2500` | 总字数上限，超出保尾 |

关闭时 `buildTopicContext()` 直接返回空串，缓冲也不写。`config.example.json` 与 README 字段表已同步。

---

## 8. 已知限制

1. **缓冲只在内存**：桥接重启后近况清空，直到新消息重新攒起来。更早的历史仍按协作规则用 `feishu-cli` 拉。
2. **卡片不展开**：别的 agent 的飞书卡片只显示 `[卡片]`，内容需要模型自己取。
3. **近况每次唤醒都带**：同一会话内后续消息会重复一个滚动窗口（总量封顶 2500 字），换取「讨论在演进」的可见性；未做增量去重。
4. **名字依赖 `feishu.names` / 群成员接口**：没权限时行里显示完整 `open_id`，略长但可 @ 回去。
5. **入队快照是排队那一刻的视角**：出队重放时比当前话题状态旧一点——这是用户发这条消息时看到的讨论，刻意保留。

---

## 9. 实现清单

| 文件 | 变更 |
|---|---|
| `src/topic-context.js` | 新增：`flattenContent` / `contextKeyOf` / `TopicLog` / `renderTopicContext` |
| `src/feishu.js` | @ 闸门之前采集；`buildTopicContext()`；`onMessage` 载荷加 `topicContext` |
| `src/handler.js` | `runPrompt` preamble 加近况块；排队条目带快照 |
| `src/config.js` / `config.example.json` | 三个默认值与模板字段 |
| `prompts.json` | `always.topicContext` 模板头；协作规则第 2 条改写 |
| `scripts/test-topic-context.mjs` / `package.json` | 52 项测试 + `npm run test:topic-context` |
| `README.md` | 能力表、群聊规则、字段表、验证表、模块职责 |
| `docs/design-notes.md` | 第十四节（为什么这么做）、验证表、文件清单、路线图边界澄清；十二节 @ 闸门补注 |

附记：交付提交中同时包含了用户此前在 `prompts.json` 未提交的一句协作规则修订（agent 发消息后可主动维持进程观察群里后续），原文逐字保留。

---

## 10. 后续

1. **计划审批**（P0 第 2 项）：把 `once / always / reject` 三态从工具级提到计划级，模型先出计划、人点通过再执行。
2. **跨会话引用**（P0 第 1 项）：新会话首条带上上一张卡片结论摘要，与 `/new` 续命形成闭环。
3. 若实测发现 2500 字窗口在长话题里不够用，再考虑「只带没 @ 我的轮次」的增量模式，不要在未量之前加复杂度。

---

## 附录 A · 提示词修订提案（待用户替换）

**状态：提案，尚未生效。** 完整可替换副本：[prompts-topic-context.proposed.json](prompts-topic-context.proposed.json)。仓库根的 `prompts.json` 未被改动，替换由用户执行。

### 为什么必须改

功能上线后，旧文案有四处事实前提失效或过期（context engineering 问题，不是措辞问题）：

| # | 旧文案 | 问题 |
|---|---|---|
| 1 | `once.rules` 第 2 条标题「主动获取话题上下文」+「只有 @ 你的消息你会进会话」 | 现在是桥接被动注入。「主动」会诱导模型照旧先跑一次 `feishu-cli` 拉历史，把刚省下的工具调用步数又烧回去；且没 @ 的轮次如今以原文形式进了模型视野，原句不再准确。**最缺的是「默认别拉」这条行为约束** |
| 2 | `always.topicContext`：「本话题最近 N 条消息**原文**」 | 主聊天流按群聚时会跨话题，「本话题」不精确；post 是拉平文本、非文本是占位符，不是原文；`→` 指针行和 `[图片]` 占位的语义没说清，模型可能把占位符当真内容 |
| 3 | `once.rules` 第 1 条「留在进程内观察群里的后续情况……而不是等待被 @ 唤醒」（用户提交的修订） | 桥接不会把新消息推给正在 sleep 的进程。留在里面只能自己轮询拉历史，或等下次被 @ 唤醒（那时近况块刷新）。意图（快速跟进讨论）保留，预期纠正 |
| 4 | `always.identityLine.opencode`：「本机飞书 CLI 的默认身份以机器配置为准，不一定是你的应用，发言前请核对」 | **事实过期**。见下方「身份注入时间线」：两个后端现在都注入本实例凭证，只是注入点不同。这句写成「默认不是你的应用」会误导模型，甚至在每次发言前去猜身份 |

### 身份注入时间线（第 4 处的证据）

| 提交 | 事实 |
|---|---|
| `f6d414e` | pi 后端的 `childEnv()` 在起子进程前注入本实例凭证；同时写下两句 `identityLine`——当时 opencode **确实没注入**，所以「以机器配置为准」是准确的 |
| `dad014e` | 提示词外置到 `prompts.json`，两句文案原样搬过去 |
| `1488d1b` | 补上 opencode 的注入：新增 `scripts/lib/feishu-identity.sh`，由 `scripts/agent/serve.sh`（launchd 路径）与 `scripts/up.sh`（手动路径）在**起 serve 之前**调用，导出 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_DOMAIN` 与 `LARKSUITE_CLI_CONFIG_DIR`；`scripts/test-feishu-identity.mjs`（18 项）守着注入脚本。**但没同步改提示词，也没改 `src/index.js` 的注释** |

**桥接进程本身确实不能给 opencode 注入**：opencode 的代理跑在常驻 serve 里，桥接只是 HTTP 客户端，无法向已启动的进程写环境变量。所以注入点挪到启动处，读实例 `config.json` 现取凭证、导出给 serve，serve 里的 bash 工具继承之。这与 README 身份注入一节、[pi-backend.md](pi-backend.md) 第 125 行的描述一致。语义与 pi 相同：**用 CLI 发言就是以本实例应用发出**。

**但例外提示要保留**：只有经桥接脚本启动的 serve 才被注入；手动 `opencode serve`、桌面 App 自带的 `serve --service` 都沿用机器级配置。`1488d1b` 修的真实事故就是「Lil_P 的代理发出的问候以 Lil_O 的应用到达群里」。所以新文案不是删掉谨慎，而是把「默认不是你的应用」改成「默认已注入，若 serve 由别的方式启动用 `echo $FEISHU_APP_ID` 核对」——把默认假设翻过来，保留可自检的出口。

`src/index.js` 构造 `FeishuTransport` 时那句「opencode 不会注入」的注释已同步修正（代码注释，不属于待替换的提示词文件）。

### 分工决策

| 位置 | 放什么 | 理由 |
|---|---|---|
| `always.topicContext`（每次唤醒都发） | 只放**格式语义**：指针行、类型占位、post 已拉平、省略注记 | 短标签不怕会话压缩丢；哪怕 `once.rules` 被压缩掉，模型仍读得懂近况块 |
| `once.rules` 第 2 条（新会话第一条发一次） | **行为策略**：直接当已知上下文用、别重复拉；只有三种情况才拉；用 thread / chat 哪个 id；CLI 怎么找 | 只在第一条发，靠会话历史记住，每轮重复白烧 token |

成本：always header 77 → 103 字（每次唤醒 +26 字），`identityLine.opencode` 64 → 123 字（每次唤醒 +59 字），once.rules 1075 → 1191 字（只发一次 +116 字）。换来的是模型不再默认发起一轮「拉历史」的工具调用，也不会在每次发言前猜身份。

### 四处具体改动

1. **header 重写**：去掉「本话题 / 原文 / 桥接替我带上」这些不精确或解释性的字，换成人能一眼读懂的格式说明；保留 `{{n}}`。
2. **规则 2 重写为「读懂话题近况，别重复拉历史」**：明确「直接当作已知上下文用，不要再跑一次 feishu-cli 把这几条拉回来」；列出三种才需要拉的情形（有省略注记 / 任务依赖更早讨论 / 要展开卡片或文件）；明确话题内用 `thread`、主聊天流用 `chat`。CLI 定位与 `--help` 的提示保留。
3. **规则 1 那句改准确**：保留「可主动维持进程」，补上「桥接不会把新消息推给你，跟进只能自己周期性拉历史，或等下一次被 @ 唤醒——那时近况块会刷新」。
4. **`identityLine.opencode` 改为与 pi 同语义**：`[身份 · 你是 {{who}}{{app}} · 启动 serve 时已注入本实例凭证，用 feishu-cli / lark-cli 发言就是以你的身份发出；若 serve 由别的方式启动，先用 echo $FEISHU_APP_ID 核对]`。保留 `{{who}}{{app}}` 变量契约不变。

另外 `_readme` 补两行：标注 `topicContext` 仅群里发、记录上述 always/once 分工，以及**实例覆盖的坑**。

### 替换步骤与校验

```bash
cp docs/prompts-topic-context.proposed.json prompts.json   # 由用户执行
# 替换后重启实例：模板在进程启动时读取
```

**替换前必查**：实例 `~/.config/opencode-feishu-bridge/config.json` 的 `prompt.prefixes` 若给 `id=rules` 填了 `text`，或 `prompt.templates` 覆盖过 `always.topicContext` / `once.rules`，实例配置优先于仓库文件，替换仓库文件不会生效。多实例部署要逐个检查。

已校验（未替换，仅针对提案文件）：

- JSON 可解析；顶层键、`always` 键、各互斥组键、`once` 键与现行文件**完全一致**（`deepMerge` 不会缺键）
- `{{变量}}` 集合完全一致：`app, appId, chat, id, msg, n, name, peers, root, scope, self, sender, senderType, thread, when, where, who`——没有代码没传的新变量，`{{n}}` 保留
- 用真实渲染链路（`FeishuTransport` 加载提案作为 `prompt.templates` → `buildTopicContext()`）输出正常：`{{n}}` 替换成实际条数、header 与原文行拼接正确、无残留 `{{` 占位符

未做：真实模型环境下的效果验证。替换后建议在群里发一条「前面有人讨论过、没 @ 我」的话题消息，观察模型是否跳过 `feishu-cli` 拉历史。

---

## 附录 B · 上下文实测（prompt-samples.md）

用户要求「实测发给桥接 agent 的上下文拼接」，于是补了可复跑的探针：

```bash
npm run probe:prompt                                  # 现行 prompts.json，5 个场景
node scripts/probe-prompt.mjs --proposed              # 提案副本
node scripts/probe-prompt.mjs --diff                  # 两版逐行差异
node scripts/probe-prompt.mjs --all --out docs/prompt-samples.md
```

`scripts/probe-prompt.mjs` 走的是**生产拼装链路**：`FeishuTransport.handleImMessage`（含 @ 闸门与近况采集）→ `onMessage`（命令分流、白名单、去重）→ `runPrompt`（三段前缀拼接）→ `oc.prompt`，在最后一步截下 `body` 原样打印。只 stub 飞书 HTTP 与后端；模板渲染、变量替换、近况快照全是真实代码。不连飞书、不发消息、不碰用户配置目录。样本存档：[prompt-samples.md](prompt-samples.md)。

### 五个场景与字数结构（现行版 → 提案版，单位：字）

| 场景 | 现行 | 提案 | 说明 |
|---|---|---|---|
| A 群聊 / 话题内 / 新会话 / opencode | 1577 | 1778 | 最完整：origin 四行 + once 规则 + 近况 + 正文 |
| B 群聊 / 话题内 / 续聊 | 458 | 543 | 无 once 规则，近况仍带 |
| C 群聊 / 主聊天流 | 1450 | 1651 | scope/ids 走 main 分支，近况按 chat 聚 |
| D 私聊 | 181 | 240 | 无 scope / peers / 近况 / 协作规则 |
| E 群聊 / 话题内 / pi | 1492 | 1634 | 与 A 只差 identityLine 分支 |

**A 场景现行版 1577 字里，`once.rules` 占 1075 字（68%）**，origin 四行合计约 293 字，近况块 185 字，用户正文 17 字。要调成本，动 once 规则比动 header 有效一个数量级。

另一个实测才看得清的事实：**主聊天流每条 @ 都是新会话，因此每条都重新带 1075 字规则**（C 场景 1450 字里同样占 1075）。话题内续聊（B）只有 458 字。如果主聊天流用量大，把协作规则从 `once` 改成「每群每天一次」之类需要另做状态，别在没量之前加。

### 实测挖出的真 bug：`create_time` 单位

探针第一次跑出来前缀时间是 `1970/1/22`，追下去发现 `src/feishu.js` 的近况采集写了 `(Number(m.create_time) || 0) * 1000`——把飞书 **13 位毫秒**时间戳又乘了一千倍，近况行的 `[HH:MM]` 会落到公元五万年。同文件 `buildPrefix` 的 `when`、`scripts/probe-msg.mjs`、`scripts/test-cards.mjs` 的夹具都按毫秒直接 `new Date(Number(...))`，只有新增的采集用了秒的口径。

已修成 `ts: Number(m.create_time) || Date.now()`，夹具同步改成毫秒，并在 `scripts/test-topic-context.mjs` 加一条断言钉住「近况行显示 10:00、无 NaN」。这类「同一字段两处口径不同」的问题，靠读代码不容易发现，跑一遍真实拼装就自己冒出来了——探针值得常留着。

### 探针自身的两个坑（已修，写在脚本注释里）

1. 不能把 `bridge.t` 换成真实 `FeishuTransport`：`runPrompt` 发卡片会走真实 SDK 取 `tenant_access_token`，假凭证直接报 10003。`FeishuTransport` 只负责「事件 → msg」，通过 `onMessage` 回调接入。
2. 唤醒消息若被排队，静默取 `captured.at(-1)` 会拿到上一次的 body，样本看起来对、其实张冠李戴。现在 `run()` 断言「这次必须产生新 prompt」，否则报错。

