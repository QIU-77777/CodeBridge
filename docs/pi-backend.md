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
| 会话 | `--session-id` 配合 `--session-dir` 生成 `<时间戳>_<id>.jsonl`；**同 id 再跑会续聊**，实测第二轮能答出第一轮约定的暗号 |
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

`prompt(sessionId, body)` 里 spawn 子进程，结束后把结果**转换成与 opencode SSE 同形状的对象**，喂给同一个 `onEvent`：

```js
{ type: 'session.execution.started',        data: { sessionID } }
{ type: 'session.text.delta',               data: { sessionID, delta: finalText } }
{ type: 'session.usage.updated',            data: { sessionID, tokens, cost, model } }
{ type: 'session.execution.succeeded',      data: { sessionID } }   // 或 failed
```

于是当前这条链路全部复用：

- `RunState` 的状态机（`running → done / failed / aborted`）
- `runCard()` 的卡片版式、前缀分割线、后缀 `in · out · $x.xx｜@我 并发送 /help`
- `setInflight()` / `reconcileInflight()`：进程跑到一半挂掉，重启后僵尸卡片照样被标成「已中止」
- 中止按钮：kill 子进程 → 合成 `execution.interrupted` → 卡片变「已中止」
- `maxParallel`、忙碌闸门、白名单、来源标注、`@我本人` 判定

**这是本方案的核心取舍：不为 pi 另写一套渲染路径。** 否则卡片版式、僵尸卡收尾、中止语义都要维护两份，必然漂移。

`prompt()` 返回的是「等到子进程结束」的 Promise。`Bridge.runPrompt()` 本来就会 `await this.oc.prompt(...)`，但结果的呈现完全靠事件，所以阻塞在这里没有副作用；反而让启动失败能走进原有的 `catch`，把卡片标成 `failed`。

### 4.3 会话

`createSession({ title, directory })` 生成一个 `pi-<随机>` id，返回与 opencode 同形的 `{ id, title, location: { directory }, model }`。子进程用：

```
--session-id <id> --session-dir <CONFIG_DIR>/pi-sessions   # 各实例天然隔离
cwd: <directory>                                          # 话题绑定的项目目录
```

`getSession(id)` 从会话目录里找 `<...>_<id>.jsonl`，存在就返回会话对象。桥接重启后内存 Map 空了，但文件还在，续聊能接上；文件也丢了就抛错，`Bridge` 现有的 `catch` 会自动重建会话。

### 4.4 超时与中止

- `timeoutMs`（默认 10 分钟）到点先 `SIGTERM`，2 秒后 `SIGKILL`，并合成 `execution.failed`，错误文案说明是超时；
- `interrupt(id)` 找到在跑的子进程 kill 掉，标记 `aborted`，**不抛出**，避免 `runPrompt` 的 catch 把 `aborted` 覆盖成 `failed`；
- 子进程 `rc !== 0` 且非主动中止 → 合成 `execution.failed`，把 stderr 尾部放进错误区。

## 5. 一次性模式下的行为差异

| 能力 | opencode 后端 | pi 后端（本阶段） |
|---|---|---|
| 执行中卡片 | 有，按 1.8s 节流刷新 | 有，但内容保持「正在等待模型响应…」直到结束 |
| 结果 | 流式逐步长出来 | **跑完一次 patch 成最终卡片** |
| 正文 / 表格 / 代码块 | 有 | 有（复用 `mdToElements`） |
| `in / out / 金额` | 有 | 有（从 `usage` 取，卡片已是两位小数） |
| 模型名 | 有 | 有（`provider/model`） |
| 中止按钮 | 调 `/interrupt` | kill 子进程，同样有效 |
| 工具调用轨迹 | 可开 `showTools` | 无（pi 的工具事件本阶段不翻译） |
| 思考过程 | 可开 `showReasoning` | 无 |
| 交互式权限卡片 | 有 | 无；pi 用 `--approve` 或对工具做限制，不给飞书按钮 |
| 看门狗 / 僵尸卡收尾 | 有 | 有 |

卡片上不额外标注「这是一次性后端」——状态词「执行中 / 已完成」已经说清楚了，多写一行是噪音。

## 6. 配置

`config.example.json` 新增一段（默认仍是 opencode，**不影响任何现有配置**）：

```json
"backend": {
  "type": "opencode",
  "pi": {
    "bin": "pi",
    "model": "",
    "timeoutMs": 600000,
    "extraArgs": []
  }
}
```

`sessionDir` 不写在配置里，固定为 `<CONFIG_DIR>/pi-sessions`，跟着配置目录走，多实例不会串会话。CLI 路径可通过 `backend.pi.bin` 指定绝对路径；`bin` 支持环境变量 `OCB_PI_BIN` 覆盖。

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

**已就绪**：`@我本人` 精确判定、白名单、来源标注（群名 / 发送者 / 人还是机器人 / 时间）、话题内会话绑定。三个机器人同群时，用户 @ 谁就只有谁醒。

**仍未解决，本阶段刻意不动**：机器人之间互 @ 没有轮次护栏。此前实测 Lil_O 与 Lil_D 已经通过 `feishu-cli` 互发真 mention 连聊了好几个回合，现在完全靠模型自己判断「不用回了」才停。一旦两边都判断该回，就是无限循环。

下一阶段建议按「同一话题 key 上连续 N 轮机器人→机器人对话就停，人类发言重置」实现，并且**放在飞书闸门层而不是 prompt 里**——写进 prompt 只是请求模型自觉，不是护栏。

另外提醒：卡片正文里写 `@名字` 只是字面字符，不产生飞书提醒；要让另一个 agent 醒，必须发真正的 `<at user_id="ou_...">`。模型需要这条能力说明，同样列入下一阶段。

## 10. 验收

离线（不消耗模型额度，不连飞书）：

```bash
npm run test:pi        # pi JSONL 解析、合成事件、超时、中止、会话续聊
node scripts/test-cards.mjs
npm run selftest
npm run test:init
```

`--dry` 模式在终端里打印卡片，可直接看一次性结果长什么样：

```bash
OCB_CONFIG_DIR=/tmp/ocb-pi-dry node src/index.js --dry
```

真机验收：新建一个飞书应用 → 一份 `backend.type = "pi"` 的配置 → `npm run up`（或手工带 `OCB_CONFIG_DIR` 起）→ 群里 @ 新机器人发一句话，应看到「执行中 → 已完成」两次卡片变化，后缀带 `in / out / 金额`。再发第二句验证话题内续聊。

## 11. 后续路线

1. **互 @ 轮次护栏**（优先级最高，多 agent 一起跑之前必须有）
2. **dsh 后端**：`dsh headless "<prompt>"`，套同一套 Backend 接口与合成事件，工作量主要在解析它的输出格式
3. **给模型的来源标注后补一行能力说明**：真 mention 的写法、群里有哪些机器人、各自的 open_id
4. **可选流式**：pi 已经给了 `text_delta`，把合成事件从「结束时一次」改成「逐条转发」即可，不用改渲染层
