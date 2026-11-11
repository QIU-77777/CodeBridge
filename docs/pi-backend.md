# pi 后端接入方案

> 状态：方案 + 实现（第一阶段）
> 日期：2026-11-05
> 目标仓库：QIU-77777/CodeBridge

## 1. 目标与边界

最终目标是让三个本机 agent 在同一个飞书群里协作：

| 机器人 | 后端 | 形态 |
|---|---|---|
| Lil_O | opencode serve | HTTP API + SSE 事件流（现状） |
| 第二个机器人 | `pi` | 一次性子进程（本方案） |
| 第三个机器人 | `dsh` | 一次性子进程（后续） |

每个机器人各有一个飞书应用、一份配置、一个进程，各自只处理「白名单用户 @ 我本人」的请求。

**本阶段只做 pi。** 明确不做：dsh 后端、流式 delta 渲染、交互式权限卡片、机器人互 @ 的轮次护栏。后两项不是不做，是不该和「接一个新后端」混在同一个变更里评审。

用户已确认的取舍：pi / dsh 都只有一次性模式，没有事件流，**跑完拿最终输出发一张卡片**完全可以接受。

## 2. 为什么不是「再复制一份 config.json」

`src/oc.js` 是 opencode v2 的 HTTP API 客户端。`Bridge` 里有 20 多处 `this.oc.*` 调用，覆盖会话、prompt、中断、模型、agent、权限；更关键的是 `start()` 里 `subscribe()` 订阅的 SSE 事件流是**整个渲染管线的唯一输入**：

```
subscribe(onEvent) → RunState.apply(ev) → flushRun() → runCard() → patchCard()
```

pi 和 dsh 都不提供 `/api/session`、`/api/event`。所以多起一个进程、换一份 appId 是不够的，后端那一层必须可替换。

好消息是：`bridge.lock`、`state.json`、`config.json` 都在各自的 `CONFIG_DIR` 下，多实例**本来就是隔离的**；`@ 我本人` 闸门按 `open_id` 精确比对也已完成。真正缺的只有后端抽象和 launchd 服务名参数化。

## 3. pi 实测结论（2026-11-05，本机）

| 项 | 结果 |
|---|---|
| 命令 | `pi -p --mode json --session-dir <dir> --session-id <id> -- "<prompt>"` |
| 输出 | **JSONL，每行一个事件**，不是一整块 JSON |
| 事件类型 | `session` / `agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `turn_end` / `agent_end` / `agent_settled` |
| 增量文本 | `message_update.assistantMessageEvent.type === "text_delta"`，`delta` 字段 |
| 最终文本 | `message_end.message.content[]` 里 `type === "text"` 的 `text` |
| 用量 | `message_end.message.usage`：`input` / `output` / `cacheRead` / `totalTokens` / `cost.total` |
| 模型 | `message_end.message.provider` + `.model`（实测 `deepseek/deepseek-v4-pro`） |
| 会话 | `--session-id` 配合 `--session-dir` 生成 `<时间戳>_<id>.jsonl`；**同 id 再跑会续聊**，实测第二轮能答出第一轮约定的暗号。终端 `pi -r` 的会话另有 `--session <jsonl 路径>` 一条路，见 4.3 |
| 退出 | `rc=0` 正常；`agent_settled.aborted` 表示被中止 |

也就是说 pi 其实**有**子进程级的事件流，只是没有常驻服务。本方案按用户要求不做流式，但数据结构允许将来几乎零成本地打开。

## 4. 设计：Backend 接口 + 合成事件

### 4.1 一个接口，两个实现

`src/backend.js` 提供 `createBackend(cfg)`，按 `backend.type` 返回：

- `opencode` → 现有 `OpencodeClient`，**一行不改**
- `pi` → 新的 `PiBackend`

`PiBackend` 对外暴露与 `OpencodeClient` **形状完全相同**的方法，因此 `Bridge` 主体不需要改。`this.oc` 这个变量名沿用（改名要动 20 多处，属于无收益的 diff），只在注释里说明现在是后端而非特指 opencode。

### 4.2 关键手法：把 pi 的输出翻译成合成事件

`PiBackend.subscribe(onEvent, onStatus)` 不做网络连接，只把回调存下来、立即回一个 `connected: true`，返回一个 no-op 的停止函数。

`prompt(sessionId, body)` 里 spawn 子进程，**边收边把 pi 的 JSONL 事件转换成与 opencode SSE 同形状的对象**，喂给同一个 `onEvent`（`_streamEvent()`，事件形状以 pi 文档 `docs/json.md` 为准）：

| pi 事件 | 合成事件 | 说明 |
|---|---|---|
| `turn_start` / `turn_end` | `session.step.started` / `session.step.ended` | 一轮助手响应加它的工具调用算一步，前缀的「步数」由此而来 |
| `message_start`（assistant，带 `model`/`provider`） | `backend.meta` | 模型名一露面就补卡片前缀，不用等跑完 |
| `message_update` → `text_delta` / `text_end` | `session.text.delta` / `session.text.ended` | 正文分片流到，`text_end` 是权威全文 |
| `message_update` → `thinking_delta` | `session.reasoning.delta` | 思考过程，`showReasoning` 打开才显示 |
| `message_update` → `toolcall_start` / `toolcall_end` | `session.tool.input.started` / `session.tool.called` | 工具名与完整参数 |
| `tool_execution_start` / `tool_execution_end` | `session.tool.input.started` / `session.tool.called` / `session.tool.success` / `session.tool.failed` | 工具执行生命周期与输出，`showTools` 打开才显示 |
| `message_end`（assistant） | `session.text.ended` + `session.usage.updated` | 权威全文与用量 |
| 进程退出 | `session.text.ended` + `session.execution.succeeded` / `failed` / `interrupted` | 终态一律用 `text.ended` 权威覆盖，流式发过的文本不会再重复一遍 |

于是当前这条链路全部复用：

- `RunState` 的状态机（`running → done / failed / aborted`）与分段保留逻辑
- `runCard()` 的卡片版式、前缀分割线、后缀 `in · out · $x.xx｜@我 并发送 /help`
- `setInflight()` / `reconcileInflight()`：进程跑到一半挂掉，重启后僵尸卡片照样被标成「已中止」
- 中止按钮：kill 子进程 → 合成 `execution.interrupted` → 卡片变「已中止」
- `maxParallel`、忙碌闸门、白名单、来源标注、`@我本人` 判定

**这是本方案的核心取舍：不为 pi 另写一套渲染路径。** 否则卡片版式、僵尸卡收尾、中止语义都要维护两份，必然漂移。

`prompt()` 返回的是「等到子进程结束」的 Promise。`Bridge.runPrompt()` 本来就会 `await this.oc.prompt(...)`，但结果的呈现完全靠事件，所以阻塞在这里没有副作用；反而让启动失败能走进原有的 `catch`，把卡片标成 `failed`。

### 4.3 会话

`createSession({ title, directory })` 生成一个 `pi-<随机>` id，返回与 opencode 同形的 `{ id, title, location: { directory }, model }`。桥接自建的会话，子进程用：

```
--session-id <id> --session-dir <CONFIG_DIR>/pi-sessions   # 各实例天然隔离
cwd: <directory>                                          # 话题绑定的项目目录
```

终端 `pi -r` 建的会话不在这套参数里：它按工作目录存在 `~/.pi/agent/sessions/<按目录编码>/` 下，`--session-id` 在桥接的平铺目录中找不到对应文件。对这类会话 `prompt()` 改传 `--session <jsonl 路径>`，cwd 取 jsonl 头部的 `cwd`，模型取 `model_change` 行——两端读写同一个文件。扫描只读每个文件的头部（`readCliSessionHead()`，上限 512KB）：id 与 cwd 在第一行，标题取第一条 `role=user` 的消息（与 pi 的 resume 选择器同源），模型取 `model_change` 行。

`getSession(id)` 先查桥接的 `index.json`，再回退到终端目录扫描。桥接重启后内存 Map 空了，但文件还在，续聊能接上；文件也丢了就抛错，`Bridge` 现有的 `catch` 会自动重建会话。

### 4.4 超时、中止与静默收尾

- `timeoutMs`（默认 10 分钟）**按活跃度算**：pi 每吐一行 stdout 就把计时器重置，只有连续 10 分钟没有任何输出才到点——先 `SIGTERM`，2 秒后 `SIGKILL`，并合成 `execution.failed`。原实现从进程启动算总时长，会把一直在干活的运行误杀（真实事故：一个运行 10 分钟里产出 16290 行、12 步，超时前一刻还在查东西）。真挂住的运行不再吐任何行，计时器到点照杀；
  - pi 侧只有两层兜底，方向不同、互不替代：本层看「有没有 stdout 输出」；`settleQuietMs`（下面那条）看「最终答案出来了没有」。
  - **`behavior.idleTimeoutMs` 对 pi 不生效**（`handler.js` 的 `watchdogIdleMs()` 按后端类型分流）。原因是 pi 的事件从子进程 stdout 逐行解析，跑「stdout 在刷但产不出 JSON 事件」的命令（npm install、长 bash）时事件会长时间没有而进程完全健康——按事件静默判定就是误杀；而且看门狗只翻新卡片不杀进程，会留下「卡片显示失败、进程还在跑」的误导状态。该看门狗只服务 opencode（事件来自 SSE 流，流断了才需要它）。
- `interrupt(id)` 找到在跑的子进程 kill 掉，标记 `aborted`，**不抛出**，避免 `runPrompt` 的 catch 把 `aborted` 覆盖成 `failed`；
- 子进程 `rc !== 0` 且非主动中止 → 合成 `execution.failed`，把 stderr 尾部放进错误区；
- **静默收尾**（`settleQuietMs`，默认 180 秒）：pi 偶发「最终回答产出了却不退出」——`agent_settled` 永远不来，进程挂住但不再吐事件。实测一次卡片在「执行中」停了 6 分 58 秒。桥接逐行读 stdout 维护几个现场（最后事件时间、是否见过 `turn_end`、有没有在进行中的助手消息或工具调用、是否见过 `agent_settled`），满足「见过最终消息、无进行中事项、静默超时」就按已完成收尾：正文取 `parsePiJsonl` 的最终文本并附一行说明，随后杀掉整个进程组。设 0 关闭，恢复「只等进程退出」的老行为。
  - 阈值分两档：**见过 `agent_settled`** 时 pi 已明确没有后续工作，静默 5 秒即收尾（只等管道里缓存的数据读完）；**没见到**时用完整阈值。
  - 默认值从 60 秒调到 180 秒：实测同一轮任务里模型轮间思考间隔到过 62 秒和 107 秒，60 秒会把还在跑的运行误判成完成——杀掉进程、把中途答案标成「已完成」，用户拿到半截结果。

### 4.5 子进程环境：发言身份钉成本实例

多机器人同机时，代理用飞书 CLI 发消息读的是机器级配置（`~/.feishu-cli/config.yaml`、`~/.lark-cli/config.json`），默认应用可能是另一个实例的。真实事故：用户让 Lil_P 跟 LilO 打招呼，Lil_P 的代理调 `feishu-cli` 发出，消息以 Lil_O 的应用到达群里。

`childEnv()` 在起子进程前准备好环境：

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_DOMAIN` 取本实例的 `cfg.feishu`。`feishu-cli` 的凭证优先级是 `--bot-app-id` > 环境变量 > 配置文件，注入即覆盖；
- `ensureLarkCliConfig()` 在实例配置目录写一份只含本实例应用的 `lark-cli/config.json`（权限 600），并把 `LARKSUITE_CLI_CONFIG_DIR` 指过去；
- 配置里没有飞书凭证时两者都不做，子进程沿用机器级配置，与老行为一致。

opencode 后端的代理跑在常驻 serve 里，桥接没法向已启动的进程注入环境变量，注入点因此挪到 serve 启动处：`scripts/lib/feishu-identity.sh` 的 `ocb_export_feishu_identity` 被 `scripts/agent/serve.sh`（launchd 路径）和 `scripts/up.sh`（手动路径）在起 serve 前调用，导出内容与本文件的 `childEnv()` 相同。身份声明行（`src/feishu.js` 的 `identityLine`）对两个后端都加，作为第二重提示。

## 5. 一次性模式下的行为差异

2026-11-07 起 pi 后端改为**边收边转发**（见 4.2 与第 10 节事故复盘），与 opencode 后端的差异只剩后端能力本身：

| 能力 | opencode 后端 | pi 后端 |
|---|---|---|
| 执行中卡片 | 按 1.8s 节流刷新 | 同样按 1.8s 节流刷新（文本增量、步数、用量、模型名都是流式的） |
| 结果 | 流式逐步长出来 | 流式逐步长出来，终态再权威覆盖一次 |
| 正文 / 表格 / 代码块 | 有 | 有（复用 `mdToElements`） |
| `in / out / 金额` | 有 | 有（每条助手消息的 `usage` 都发 `session.usage.updated`） |
| 模型名 | 有 | 有，且**不等跑完**：第一条助手消息带着 `model`/`provider`，`backend.meta` 立即补前缀 |
| 步数 | 有 | 有（`turn_start` / `turn_end` → `session.step.started` / `ended`，一轮一记） |
| 中止按钮 | 调 `/interrupt` | kill 子进程，同样有效 |
| 工具调用轨迹 | 可开 `showTools` | 可开 `showTools`（`toolcall_*` / `tool_execution_*` 全套翻译，见 4.2） |
| 思考过程 | 可开 `showReasoning` | 可开 `showReasoning`（`thinking_delta` → `session.reasoning.delta`） |
| 交互式权限卡片 | 有 | 无；pi 用 `--approve` 或对工具做限制，不给飞书按钮 |
| 看门狗 / 僵尸卡收尾 | 有 | 有 |

仍然没有的只有三样：交互式权限卡片、`/agent`、常驻服务意义上的「会话列表来自服务端」。卡片上不额外标注「这是 pi 后端」——状态词「执行中 / 已完成」已经说清楚了，多写一行是噪音。

## 6. 配置

`config.example.json` 新增一段（默认仍是 opencode，**不影响任何现有配置**）：

```json
"backend": {
  "type": "opencode",
  "pi": {
    "bin": "pi",
    "model": "",
    "timeoutMs": 600000,
    "settleQuietMs": 180000,
    "extraArgs": []
  }
}
```

`sessionDir` 不写在配置里，固定为 `<CONFIG_DIR>/pi-sessions`，跟着配置目录走，多实例不会串会话。CLI 路径可通过 `backend.pi.bin` 指定绝对路径；`bin` 支持环境变量 `OCB_PI_BIN` 覆盖。

**终端会话也看得见。** 人类在终端 `pi -r` 里建的会话按工作目录存在 `~/.pi/agent/sessions/<按目录编码>/<时间戳>_<uuid>.jsonl`，与桥接的平铺目录原本互不可见。桥接启动时也会扫这个根目录（默认 `~/.pi/agent/sessions`，可用 `backend.pi.cliSessionRoot` 覆盖），`/sessions` 把两类会话合在一起列出，终端那条带「终端」标记。切换过去后 `prompt()` 对终端会话传 `--session <jsonl 路径>`（桥接自建的仍传 `--session-id`），两端读写同一个文件。终端会话的标题、模型写在 jsonl 里由 pi 维护，改名 / 删除 / 切模型三个操作在桥接里明确拒绝。

### 6.1 GitHub 身份（`github` 段）

每个实例可以配一个自己的 GitHub 身份，agent 推送、开 PR 时以它行事，不占用人的账号。默认 `mode: "off"`，不注入任何东西，现有部署零改动。

```json
"github": {
  "mode": "app",
  "appId": 5653982,
  "installationId": 179512681,
  "privateKeyPath": "~/.config/opencode-feishu-bridge/github-app.pem",
  "token": "",
  "gitName": "Lil_O",
  "gitEmail": "353665731+lil-o-bot[bot]@users.noreply.github.com"
}
```

`gitEmail` 的数字部分是**机器人用户的 ID**，不是 App ID。两者形式不同、效果也不同：

| 形式 | GitHub 是否关联到机器人账号 |
|---|---|
| `353665731+lil-o-bot[bot]@users.noreply.github.com`（用户 ID） | 是，提交显示机器人标识 |
| `5653982+lil-o-bot[bot]@users.noreply.github.com`（App ID） | 否，提交显示为普通文本 |

填 App ID 不会报错，只是提交关联不到账号——PR 页面里自己的提交没有头像、合并提交却有。查 ID 的办法：`curl -H "Authorization: Bearer <安装令牌>" https://api.github.com/users/<bot名>[bot]`，返回的 `id` 就是。

| 字段 | 说明 |
|---|---|
| `mode` | `off`（默认，不注入）/ `app`（GitHub App）/ `pat`（个人访问令牌） |
| `appId` / `installationId` | GitHub App 页面与安装 URL 里的两个数字 |
| `privateKeyPath` | App 私钥 `.pem` 路径，放实例配置目录、权限 600（与 `appSecret` 同规格） |
| `token` | 仅 `pat` 模式使用 |
| `gitName` / `gitEmail` | 提交署名，注入 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` |

**GitHub App 是什么**：在你的账号下注册的一个集成身份，对外显示 `lil-o-bot[bot]`。agent 不登录——每次操作前用 App 私钥签一个 JWT（10 分钟有效），换一个 installation token（1 小时有效）。这层换算由 `src/github-app-token.mjs` 自动完成：磁盘缓存 + 剩余 5 分钟自动换 + 401 重试一次。App 安装时选 All repositories，当前和将来的仓库都覆盖，配置里不用按仓库列。

**四路注入**（`src/github-identity.js`，与飞书身份注入同一个调用点）：

1. `GH_TOKEN`——启动时取一个有效的，给直接读环境变量的工具；
2. `GIT_AUTHOR_*` / `GIT_COMMITTER_*`——提交署名，优先级高于仓库和全局配置；
3. `GIT_CONFIG_COUNT` 等——让 git 每次操作现场调凭证助手（`src/github-app-credential.mjs`）换有效 token。长驻进程（opencode serve）里启动时导出的 token 一小时后会过期，这条路让过期对 agent 透明；
4. `PATH` 前置本实例的 `gh` 包装脚本（`<CONFIG_DIR>/bin/gh`），gh 的每次调用同样现取 token。

**pi 后端**（`src/pi.js` 的 `childEnv()`）在起子进程前注入；**opencode 后端**由 `scripts/lib/github-identity.sh` 在起 serve 前导出（`scripts/agent/serve.sh` 与 `scripts/up.sh` 各调一次）。两边语义一致。

排障：`node src/github-app-token.mjs --config-dir <实例配置目录>` 可直接看当前 token 状态。

「注入之后到底谁生效」用这条命令确认——它会打印 git 实际调用了哪个凭证助手：

```bash
while IFS= read -r l; do [ -z "$l" ] && continue; export "${l%%=*}=${l#*=}"; done \
  < <(node src/github-identity.js --config-dir <实例配置目录>)
printf 'protocol=https\nhost=github.com\n\n' | GIT_TRACE=1 git credential fill
```

trace 里应该只有我们的助手在跑（`github-app-credential.mjs get`）。如果看到 `gh auth git-credential` 或 `git-credential-osxkeychain` 跑在我们前面，说明机器级助手没被清掉——`GIT_CONFIG_COUNT` 第一条的空值重置就是为这个存在的（真实事故：不重置时我们的助手永远排在最后，一次都不被调用）。

重置用的是 URL 作用域的键（`credential.https://github.com.helper`），**只清 github.com 上累积的助手，不影响其他主机**。git 的凭证配置按 URL 组件逐级匹配，所以这个空值的作用范围与助手键完全一致。早期版本用过不带 URL 的通用键，会把所有主机的助手都清掉：agent 操作内部 GitLab、Gitee 时机器上原本的凭证来源被静默抹掉，只剩一句「读不到用户名」——那类远端的 git 操作会直接失败。想确认某个非 GitHub 主机没被影响，把命令里的 `host=github.com` 换成那个主机即可。

### 6.2 prompt 前缀（`prompt` 段）

每条消息发给模型前，正文前面会拼一段前缀。前缀分两种模式，因为两类信息的**变化频率不同**：

| 模式 | 拼法 | 装什么 |
|---|---|---|
| `always` | 每条消息都拼 | 携带**本条消息**动态数据的内容：来源标注（群名 / 话题 / 发送者 / 时间）、协作 id（chat / thread / root / msg / self）、可@的同伴、身份声明。文案模板在 `prompts.json` 的 `always` 组，取值由代码生成，不走 `prefixes` |
| `once` | 每个会话的第一条消息拼一次 | 静态规则：协作机制说明，模板是 `prompts.json` 的 `once.rules`。第一条拼过之后它就在会话历史里，后续消息靠上下文记住——每轮重复只是白烧 token |

模板文件也按 `always` / `once` 分两层，和这里的 `prefixes.mode` 是同一个频率概念：前者管每条消息的标注、协作 id 与身份，后者管静态规则发几次。互斥选项（群 / 私聊、话题 / 主聊天流、pi / opencode 等）在模板文件里收成字典，运行时只选一个，清单直接看 `prompts.json` 的 `always` 组键名。

```json
"prompt": {
  "prefixes": [
    { "id": "rules", "mode": "once", "text": "" },
    { "id": "house-style", "mode": "always", "text": "回答用中文。不确定的事说不确定，不要猜。" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id: "rules"` | 协作机制说明。`text` 留空 = 用 `prompts.json` 的 `once.rules` 模板；填写 = 用你的版本。只在群里拼，私聊没有同伴 |
| 其他 `id` | 自定义前缀，纯静态文本，想加几条加几条 |
| `mode` | `once` = 每会话第一条；缺失或 `always` = 每条消息都拼 |
| 删掉某个条目 | 关闭该前缀。`prefixes: []` = 只留代码生成的来源标注、协作 id 和身份声明 |

**默认行为**（配置里没有 `prompt` 段时）：协作规则 once 模式、只在群里拼。也就是说升级后行为自动变成「规则只带一次」——不需要改任何配置。

**拼装顺序**：来源标注 → 协作 id → 身份声明 → 可@的同伴 → 配置里 always 的条目 → （仅新会话）配置里 once 的条目 → 空行 → 用户正文。

**「新会话」怎么判定**：`src/handler.js` 的 `runPrompt()` 里，`getSession()` 抛错或没有绑定、因而走了 `createAndBind()` 的那一次。续聊（`getSession()` 成功）不拼。pi 后端每次 prompt 都是新进程，但会话历史由 `--session-id` 续上，规则仍在上下文里；会话被压缩（compaction）后规则可能滚出上下文，那时把该条目改成 `always` 即可。


## 7. 多实例：一个机器人 = 一个应用 + 一份配置 + 一个进程

```
~/.config/opencode-feishu-bridge/           → Lil_O   backend=opencode   appId=cli_aa26…
~/.config/opencode-feishu-bridge-pi/        → Lil_Pi  backend=pi         appId=cli_<新应用>
~/.config/opencode-feishu-bridge-dsh/       → Lil_Dsh backend=dsh(后续)  appId=cli_<新应用>
```

三个进程各读各的 `OCB_CONFIG_DIR`，`bridge.lock` / `state.json` / `pi-sessions` 全在各自目录下，互不干扰。

**只有 opencode 那个实例需要 `opencode serve`**，pi / dsh 实例只起桥接进程。因此：

- `install-agent.sh` 增加 `--instance <name>`，launchd label 变为 `ai.qiguang.ocbridge.<name>.{serve,app}`，并把 `OCB_CONFIG_DIR` 写进 plist 的 `EnvironmentVariables`；
- `OCB_INSTANCE` 环境变量让 `up.sh` / `down.sh` / `status.sh` 找到对应 label；缺省实例保持现有 label 不变，**老部署零改动**；
- `agent/bridge.sh` 里「等 opencode serve 起来」的 60 秒循环，在 `backend.type !== 'opencode'` 时跳过。

每个飞书应用的 `appId` / `appSecret` / `botOpenId` 都不同，`allowlist` 与 `names` 里的 `open_id` **也按应用隔离，不能从第一个机器人复制**。

## 8. 命令降级

| 命令 | pi 后端的处理 |
|---|---|
| `/new`、`/cd` | 正常，新建本地会话并绑定 |
| `/sessions`、`/switch` | 正常，列的是该实例的 pi 会话文件 |
| `/status` | 正常，服务器信息显示 `pi` CLI 版本 |
| `/stop`、中止按钮 | 正常，kill 子进程 |
| `/rename`、`/del` | 正常，作用于本地会话文件 |
| `/model` | 列出 `backend.pi.model` 指定的模型和历史会话里用过的模型；不调用 `pi --list-models`，两者都空时列表为空，需先在配置里指定 `backend.pi.model`。切换改会话内模型 |
| `/agent` | 明确回「pi 后端没有 opencode 的 agent 概念」 |
| 权限卡片回调 | 不会发生；收到旧卡片的 `perm` 动作时只回一个 info toast |

`/help` 卡片会按后端能力标注哪些命令不可用，避免用户照着一份全量清单去试。

## 9. 协作的前提与当前风险

**已就绪**：`@我本人` 精确判定、白名单、来源标注（群名 / 话题 / 发送者 / 人还是机器人 / 时间）、协作 id 前缀（chat / thread / root / msg / self）、可@的同伴 id、话题内会话绑定。三个机器人同群时，用户 @ 谁就只有谁醒。

**仍未解决，本阶段刻意不动**：机器人之间互 @ 没有轮次护栏。此前实测 Lil_O 与 Lil_D 已经通过 `feishu-cli` 互发真 mention 连聊了好几个回合，现在完全靠模型自己判断「不用回了」才停。一旦两边都判断该回，就是无限循环。要注意的是：协作规则被广泛告知之后，循环的「可达性」其实是变高的——agent 现在确切知道怎么互相唤醒，起循环比不知道时更容易。

下一阶段建议按「同一话题 key 上连续 N 轮机器人→机器人对话就停，人类发言重置」实现，并且**放在飞书闸门层而不是 prompt 里**——写进 prompt 只是请求模型自觉，不是护栏。

协作规则由桥接自动拼给每个 agent：群会话第一条消息的 prompt 前面会拼一段「协作」说明，文本来自 `prompts.json` 的 `once.rules` 键，测试见 `scripts/test-cards.mjs` 的来源标注一节。它使用 **once 模式**，只在该会话的第一条消息拼，之后靠上下文记住，每轮重复只是白烧 token（配置与两种模式的含义见 6.2 节）。规则内容以模板文件为准，包含真 mention 的写法、open_id 的获取途径（前缀的「可@的 id」一行、发送者标注、问人类）、话题内发言的落点（`--reply` 前缀「协作 id」里的 root 或 msg）、卡片不唤醒任何人。私聊不拼这段。

这行说明的来历是一次实测：Lil_O 明明拿到了 Lil_P 的 open_id（就在收到的消息标注里），却在卡片上回复，两个 agent 完全没对话上；人工告知某一个之后它才会，另一个仍然不会。规则不能靠逐个教，必须进标注。

## 10. 一次真实事故复盘（2026-11-07）

### 现象

用户在飞书里让 Lil_P「阅读一下这个项目」。任务 44 秒就跑完了，但卡片永远停在「⏳ 执行中」——标题是执行中，正文却是完整答案，前缀只有目录和耗时，没有模型和步数。用户追问「你执行完了吗」，Lil_P 其实从 14:18:19 一直干活到 14:25:52（pi 会话文件里的工具调用连绵不断），但新卡片 8 分 24 秒没有任何变化，用户一个字都看不到，最后手动点了中止。

### 根因（三条，互相独立）

1. **终态 patch 与文本 patch 竞争**（`src/handler.js`）。pi 的 `finish()` 在同一时刻连发 `text.delta` / `usage` / `backend.meta` / `succeeded` 四个事件，前一个触发一次立即 patch，后一个又触发一次，两个请求同时在途。飞书侧的生效顺序没有保证：「已完成」快照先到、「执行中」快照后到，卡片就停在旧状态。同一份代码在另一次运行上落地正确，说明竞争结果不确定。修复：`flushRun()` 改为串行——在途期间到达的刷新只标记 `patchDue`，由在途那次落地后带上最新快照再发；快照在发送时构建，终态一定最后生效。两个后端都受益（opencode 的末段文本与终态事件同样可能挤在同一时刻）。
2. **运行期间没有任何事件**（`src/pi.js`）。旧实现只把 stdout 攒进缓冲区，进程结束才一次性解析，运行中的卡片一次都不刷新。修复：`_streamEvent()` 逐条翻译（见 4.2 的表），文本、工具、步数、模型名、用量全部边收边发。
3. **模型名与步数缺失**。模型：会话创建时是空的（配置没写 `backend.pi.model`），真实模型只出现在助手消息里，旧实现只在终态补一次——终态 patch 丢了就永远没有。步数：pi 后端从不发 `session.step.started`，`RunState.steps` 永远是 0，前缀的「步数」字段（`steps > 1` 才渲染）永远不出现。两条都已修（4.2 的映射表）。

### 排查中被证据逼出来的第三个修点

静默收尾的默认值 60 秒小于实测的模型轮间思考间隔（同一轮任务里出现过 62 秒和 107 秒的间隔）。不修的话，重启加载新代码后，多轮运行会被误判成完成：杀掉进程、把中途答案标成「已完成」。默认值因此调到 180 秒，并给「见过 `agent_settled`」加了 5 秒的快速通道（见 4.4）。

### 证据怎么拿的

- 卡片真状态：飞书 API 读卡片原文（标题、模板、`update_time`），比任何日志都直接；
- pi 干了什么：`<CONFIG_DIR>/pi-sessions/<时间戳>_<会话id>.jsonl`，每条消息带时间戳；
- 桥接做了什么：`logs/bridge.log` 的 `[group]` / `卡片回调` 行；
- 会话绑定：`<CONFIG_DIR>/state.json` 的 `chats` 与 `inflight`。

教训：**当时跑着的桥接进程是 8 小时前启动的旧代码**（launchd 的 `KeepAlive` 只保证进程活着，不会重新加载磁盘上的代码）。改完 `src/` 必须重启桥接才生效，排障时第一件事是确认进程启动时间与文件修改时间的先后。

## 11. 验收

离线（不消耗模型额度，不连飞书）：

```bash
npm run test:pi        # pi JSONL 解析、流式映射、合成事件、超时、中止、静默收尾、会话续聊
npm run test:github     # GitHub App 身份：JWT、token 缓存刷新、四路注入、凭证助手
npm run test:patch     # 卡片 patch 串行与合并（终态一定最后生效）
node scripts/test-cards.mjs
npm run selftest
npm run test:init
```

`--dry` 模式在终端里打印卡片，可直接看流式过程长什么样：

```bash
OCB_CONFIG_DIR=/tmp/ocb-pi-dry node src/index.js --dry
```

真机验收：群里 @ 机器人发一句需要多轮工具调用的话（例如「读一下这个项目」），应看到卡片按约 1.8 秒的节流持续刷新：正文分段长出、前缀带模型名与步数、耗时走动；终态标题变「✅ 已完成」，后缀带 `in / out / 金额`。中途再发一句，验证它默认排进队列（卡片说明排第几位，不需要点按钮）；点「引导」验证「已中止」且正文保留已流到的内容，点「取消」验证那条消息不再发出。

## 12. 后续路线

1. **互 @ 轮次护栏**（优先级最高，多 agent 一起跑之前必须有）
2. **dsh 后端**：`dsh headless "<prompt>"`，套同一套 Backend 接口与合成事件，工作量主要在解析它的输出格式
3. ~~给模型的来源标注后补一行能力说明~~（已完成：文案在 `prompts.json` 的 `once.rules` 键，配置方式见 6.2 节）
5. **放行名单**（已完成）：`feishu.allowlist`（手写白名单）与 `feishu.listen`（单向放行「它的 @」）取并集，admin「谁能唤醒它」一张表管；`feishu.names` 供来源标注显示名字。三者全是人手动维护——自动攒的 contacts 通讯录已下线（攒出来的 open_id 用不上）。设计取舍见 README「放行名单」一节
4. ~~可选流式~~（已完成，见 4.2）
