# opencode ⇄ 飞书 桥接

把本机运行的 [opencode](https://opencode.ai) 接到飞书机器人上。在飞书里发一句话，本机 opencode 在你的项目目录里干活，过程和结果流式推回一张飞书卡片。

适合：opencode 装在自己电脑上，想在外面用手机派活、看结论的人。
不适合：需要多人协作或云端执行沙箱的场景。

---

## 能力

| 能力 | 说明 |
|---|---|
| 远程下任务 | 飞书里发一句话，本机 opencode 在指定项目目录执行 |
| 多会话 | `/sessions` 出列表点按钮切；`/new` 开新任务。会话按目录隔离 |
| 实时进度 | 卡片流式更新：正文、步数、token、耗时、成本 |
| 富文本 | markdown 表格渲染成真表格，代码块带语法高亮 |
| 权限审批 | opencode 要读 `.env`、动敏感文件时，飞书弹卡片，点允许一次/总是/拒绝 |
| 模型切换 | `/model` `/agent` 在线换，不用重启 |
| 多项目 | `/cd` 换目录，每个目录一份独立会话列表 |
| 免公网 | 走长连接，不需要公网 IP、不需要内网穿透 |

---

## 它长什么样

同一套交互的两个切面。

**左**：发一句话 → 卡片流式回结果。中间那张表是**模型输出的 markdown 表格**，被渲染成了飞书原生表格组件（不是文字）。<br>
**右**：`/cd` 换目录后 `/sessions` 出列表，点「切换」换会话，历史回复原封不动。

<table>
<tr>
<td valign="top"><img src="docs/images/request-and-reply.png" alt="发起请求与接收回复" height="520"><br>
卡片顶部一行元信息：<b>目录</b> / <b>模型</b> / <b>耗时</b> / <b>步数</b>；底部一行用量：<code>in</code> / <code>out</code> / <code>$</code>。工具调用链路默认不显示，只看结论。</td>
<td valign="top"><img src="docs/images/session-switch.png" alt="多会话管理" height="520"><br>
会话按目录隔离，列表中只出现当前目录下的会话。每条后面有「已用时长 · 模型 · 累计成本」，点「切换」后新发一条确认卡片。</td>
</tr>
</table>

---

## 快速开始

需要 Node.js 20+ 和已经装好的 opencode。

### 1. 启动 opencode serve

opencode v2 的 serve 默认生成随机密码，重启就变。固定它，省得每次改配置：

```bash
# 在哪个目录起，serve 的默认项目就是哪个
# 桥接不受这个限制：创建会话时可以指定任意目录
cd ~/你的项目
OPENCODE_SERVER_PASSWORD='my-secret-123' opencode serve --port 19876 --hostname 127.0.0.1
```

验证：

```bash
curl -s -u opencode:my-secret-123 http://127.0.0.1:19876/api/info
# {"version":"2.0.32","pid":12345,...}
```

> 端口要和配置里的 `opencode.url` 对上，用 4096 也行，改配置即可。

### 2. 创建飞书应用

打开 <https://open.feishu.cn/app> → **创建企业自建应用**（名字随便，比如 `opencode`）。

**2.1 添加机器人能力** ｜ 「添加应用能力」→ 机器人 → 启用。

**2.2 加权限** ｜ 「开发配置 → 权限管理」→ 搜索并添加：

| 权限 | 用途 |
|---|---|
| `im:message` | 收发消息（含更新卡片） |
| `im:message:send_as_bot` | 以应用身份发消息 |
| `im:message.p2p_msg:readonly` | 读用户私聊机器人的消息 |
| `im:message.group_at_msg:readonly` | 读群里 @机器人 的消息 |
| `im:chat:readonly` | 可选，读群信息 |

**2.3 事件订阅** ｜ 「开发配置 → 事件与回调 → 事件配置」→ 订阅方式选 **使用长连接接收事件** → 添加 `im.message.receive_v1`（接收消息）。

**2.4 卡片回调** ｜ 同一页面切到 **「回调配置」** tab → 订阅方式选 **使用长连接接收回调** → 添加 `card.action.trigger`（卡片回传交互）。

> 有些版本的界面把这一项放在「事件配置」里，名字叫「卡片回传交互」，效果一样。**漏了这一步，卡片上的按钮会一直转圈没反应。**

**2.5 发布** ｜ 「版本管理与发布」→ 创建版本 → 申请发布。

- 企业自建应用通常需要管理员审批，通过后机器人才可用。
- 权限变更后必须**重新发版**才生效。

**2.6 拿凭证** ｜ 「凭证与基础信息」→ 复制 **App ID**（`cli_` 开头）和 **App Secret**。

### 3. 填配置

```bash
open ~/.config/opencode-feishu-bridge/config.json
```

```json
{
  "feishu": {
    "appId": "cli_a1b2c3d4e5f6g7h8",
    "appSecret": "你的 App Secret",
    "domain": "feishu",
    "allowlist": ["ou_你的open_id"],
    "requireMention": true
  },
  "opencode": {
    "url": "http://127.0.0.1:19876",
    "password": "my-secret-123",
    "defaultDirectory": "/Users/you/project",
    "defaultModel": "stepfun-step-plan/step-5-preview"
  },
  "behavior": {
    "streamIntervalMs": 1800,
    "showReasoning": false,
    "showTools": false,
    "maxBodyChars": 6000,
    "idleTimeoutMs": 900000
  }
}
```

两个必填项：

- **`defaultModel` 一定要填**，格式 `providerID/modelID`。opencode 的默认模型多是 free 模型，部分地区会报 `RegionError: This model is not available in your country`。

  列出可用模型：

  ```bash
  curl -s -u opencode:my-secret-123 http://127.0.0.1:19876/api/model \
    | python3 -c "import sys,json;[print(f\"{m['providerID']}/{m['id']}\") for m in json.load(sys.stdin)['data']]"
  ```

  `npm run doctor` 会校验你填的这个在不在列表里。

- **`allowlist` 强烈建议填**。空数组等于谁私聊机器人都能操作本机的 shell 和文件。填自己的 `open_id`，获取方法：先留空跑起来，给机器人发条消息，控制台日志里会打印「拒绝非白名单用户」，从里面拿到 id。

### 4. 体检

```bash
npm run doctor
```

检查 Node 版本、配置完整性、opencode 连通性、模型是否在列表里、默认目录是否存在。全绿再往下。

### 5. 启动

```bash
./scripts/up.sh     # 启动（同时拉起 serve 和桥接，后台常驻，写 pid 文件）
./scripts/down.sh   # 停止
tail -f logs/bridge.log
```

`up.sh` 会读配置里的 `password` 用同样的密码起 serve，不用手动对齐两边。

调试时也可以前台跑，能看到全部日志：

```bash
npm start
```

看到 `✅ 桥接已就绪` 后，飞书里搜机器人名字，私聊发 `/help`。

> **不要同时跑两个桥接进程。** 有单实例锁（`~/.config/opencode-feishu-bridge/bridge.lock`），第二个会直接报错退出——否则同一条消息会被回两遍。

---

## 怎么用

**一条请求 = 一条消息，只增不改。**

| 你的操作 | 消息怎么动 |
|---|---|
| 发一条消息 | 新开一张卡片承载这次执行，流式在**这张卡内部**更新 |
| 点「会话列表」 | **新发**一条列表卡片，原来那条回复原封不动 |
| 点「切换」/「新会话」/「授权」 | **新发**一条结果卡片，历史回复不动 |
| 在列表里翻页 | 只更新列表卡片自己 |

历史回答永远不会被按钮操作顶掉。卡片内部的流式刷新是例外——那是同一条消息的进度更新。

同一个会话同时只跑一个任务。上一条还在执行时再发消息会被挡回来，提示先等它结束或 `/stop`。想并行跑两件事，用 `/new` 开第二个会话。

### 命令

| 命令 | 作用 |
|---|---|
| 直接发文本 | 发给当前绑定会话。没绑定会自动建一个 |
| `/help` | 命令列表 |
| `/new [目录]` | 新建会话并绑定，可指定项目路径 |
| `/sessions` | 会话列表卡片，点「切换」即切 |
| `/switch <序号\|id>` | 文本方式切会话 |
| `/rename <标题>` | 重命名当前会话 |
| `/del <序号>` | 删除会话 |
| `/cd <目录>` | 换工作目录并重置绑定 |
| `/stop` | 中止当前执行 |
| `/status` | 看绑定、模型、tokens、成本 |
| `/model` | 模型列表；`/model <序号>` 切换 |
| `/agent` | Agent 列表；`/agent <名字>` 切换 |

别名：`/ls` = `/sessions`，`/use` = `/switch`，`/abort` = `/stop`，`/delete` = `/del`，`/?` = `/help`。

---

## 卡片能显示什么

模型输出的 markdown 会被拆开，分别落到合适的飞书组件上：

| Markdown 语法 | 显示效果 |
| --- | --- |
| 表格 | 原生表格，表头灰底、可对齐；超过 10 行飞书内部分页 |
| 围栏代码块 | 带语法高亮的代码块 |
| `## 标题` | 加粗（飞书正文不支持真正的标题层级） |
| `- 列表` / `> 引用` | 圆点列表 / 去掉引用符号的正文 |
| 加粗、斜体、行内代码、链接 | 原样支持 |

几点使用上的注意：

- 单张卡片上限 30KB，所以超大表格会被裁剪：最多 50 行 8 列，超出会提示还剩多少内容。
- 流式过程中表格写到一半（只有表头、分隔行还没出来）会先显示成 `a ｜ b` 的样子，写完就变回真表格，属正常现象。
- 卡片上的表格是组件，能翻页但点不了排序。
- 工具调用链路默认不显示，只看结论。想看轨迹改 `behavior.showTools: true` 重启；完整轨迹在电脑上的 opencode 里。

---

## 配置项

| 键 | 说明 | 默认 |
|---|---|---|
| `feishu.appId` / `appSecret` | 飞书应用凭证 | — |
| `feishu.domain` | `feishu` 或 `lark`（国际版） | `feishu` |
| `feishu.allowlist` | open_id 白名单，空 = 不限制（不建议） | `[]` |
| `feishu.requireMention` | 群聊是否必须 @机器人 | `true` |
| `opencode.url` | serve 地址 | `http://127.0.0.1:19876` |
| `opencode.password` | 与 `OPENCODE_SERVER_PASSWORD` 一致；serve 没设密码就留空 | `""` |
| `opencode.defaultDirectory` | `/new` 不带目录时用这个 | `$HOME` |
| `opencode.defaultModel` | `providerID/modelID`，**建议必填** | `""` |
| `behavior.streamIntervalMs` | 卡片刷新间隔，别低于 1200（飞书 patch 有频率限制） | `1800` |
| `behavior.showReasoning` | 是否把模型思考过程推到卡片 | `false` |
| `behavior.showTools` | 是否展示工具调用链路 | `false` |
| `behavior.maxBodyChars` | 卡片正文最大字符数，超出保留尾部 | `6000` |
| `behavior.idleTimeoutMs` | 多久没收到事件就判定卡死并收尾卡片；设 0 关闭 | `900000`（15 分钟） |

环境变量可覆盖同名项：`FEISHU_APP_ID` `FEISHU_APP_SECRET` `OPENCODE_URL` `OPENCODE_SERVER_PASSWORD` `BRIDGE_DEFAULT_DIR` `BRIDGE_DEFAULT_MODEL` `BRIDGE_ALLOWLIST`（逗号分隔）。

---

## 排障

| 现象 | 排查方向 |
|---|---|
| 启动报 `连不上 opencode serve` | serve 没起，或端口/密码不对。先 `curl -u opencode:密码 http://127.0.0.1:19876/api/info` |
| 报 401 | `opencode.password` 和 serve 的密码不一致。用 `up.sh` 起会按配置对齐；手起 serve 时注意 |
| 飞书发消息没反应 | 应用没发布 / 权限没审批通过 / 事件订阅没选「长连接」 |
| 按钮点了转圈没返回 | 「回调配置」里没加 `card.action.trigger` |
| 群聊不回 | 没 @机器人（`requireMention: true`），或没把机器人拉进群 |
| 报 `RegionError` | `defaultModel` 用了当前地区不可用的模型，换一个 |
| 卡片不更新 | `streamIntervalMs` 设太低被限流，调回 1800 |
| 卡片一直停在「执行中」 | 事件流断了但进程还活着。看 `logs/bridge.log` 有没有「事件流断开」；`idleTimeoutMs` 到期会自动转失败 |
| 同一条消息回两遍 | 跑了两个桥接实例。`./scripts/down.sh` 全停再 `./scripts/up.sh` |

日志：前台跑打在 stdout，后台跑看 `logs/bridge.log`。

---

## 已知限制

1. **只处理文本消息。** 图片、文件、语音会回一句「暂不支持」。
2. **同一会话任务串行。** 上一条没结束，新消息会被拒绝，不会排队。
3. **卡片更新有 1~2 秒间隔**，不是逐字打字机效果。飞书 patch 接口有频率限制，调快会被限流。
4. **桥接进程必须活着。** 合盖休眠、断网、退出终端，机器人都失效。要真常驻得配 launchd 或找台常开的机器。
5. **群聊里所有人共用一个绑定。** 没有按用户区分会话的机制。

---

## 验证安装是否正常

不接飞书也能跑通整条链路：

```bash
npm run dry
```

终端 REPL，把飞书换成 stdin，卡片打成 ASCII 框。创建会话、流式事件、卡片渲染、命令全部跟真机一致。

带真实模型的集成自测（需要 serve 在跑）：

```bash
npm run selftest -- --model stepfun-step-plan/step-5-preview
```

会真实建会话、发 prompt、删会话，覆盖 serve 连通、状态持久化、流式聚合、增量 patch、历史消息不被覆盖、全部命令、卡片回调、白名单拦截。

---

## 适合改代码的人

```
飞书 App
  │ ① WebSocket 长连接  ← 收事件（im.message.receive_v1 / card.action.trigger）
  │ ④ HTTPS REST        → 发/改卡片（im/v1/messages create / patch）
  ▼
src/feishu.js   长连接与收发（@larksuiteoapi/node-sdk，自动续 tenant_access_token）
  ▼
src/handler.js  命令分发、会话绑定、prompt 下发、卡片回调
  │   └── src/store.js   chat_id → { sessionId, directory }
  ▼
src/oc.js       opencode v2 HTTP API + SSE 事件流（自动重连）
  ▼
opencode serve  →  本地项目目录
```

两个关键设计：`/api/session` 建会话时带 `location.directory`，所以一个 serve 就能服务任意多个项目；事件流每条都带 `sessionID`，按它过滤只刷新对应那张卡片。

```
src/md.js      Markdown → 飞书卡片元素（表格/代码块/标题/列表分段解析）
src/cards.js   卡片模板（card 2.0）
src/render.js  事件 → 运行态聚合
scripts/       体检、自测、卡片探针、端到端验证
```

设计取舍、踩过的平台坑、以及为什么不用现成方案，见 [docs/design-notes.md](docs/design-notes.md)。
