# 飞书 ⇄ 本地 Agent 桥接

把飞书消息变成任务，交给本机 Agent 在指定项目目录执行，再把过程与结果流式推回一张飞书卡片。内置 [opencode](https://opencode.ai) 与 `pi` 两种执行后端；其他命令行 Agent 实现 `Backend` 接口后走同一条链路。事件走飞书长连接，无需公网 IP 与内网穿透。

- 交互层与执行层分离：卡片、命令、会话、排队、中止、僵尸卡收尾由桥接管，具体 Agent 负责执行任务并产生事件。
- 一个进程服务一个机器人。换执行后端只改 `backend.type`。
- 配置与状态放在家目录，仓库内只保留不含密钥的模板 `config.example.json`。
- 运行时依赖只有一个：`@larksuiteoapi/node-sdk`。

更细的产品说明、截图、卡片渲染细节与后台逐步操作见 [README.full.md](README.full.md)。设计取舍见 [docs/design-notes.md](docs/design-notes.md)。

---

## 它能做什么

| 能力 | 行为 |
|---|---|
| 远程派活 | 飞书里发一句话，本机 Agent 在指定项目目录执行 |
| 流式卡片 | 正文、步数、耗时、token、成本在同一张卡片内刷新 |
| 富文本 | Markdown 表格渲染成飞书原生表格，代码块带语法高亮 |
| 多会话 | `/sessions` 列出会话并点按钮切换；`/new` 新建；`/cd` 换目录 |
| 群里并行 | 每 @ 一次开一条话题，一条话题一个会话，多条话题并行执行 |
| 权限审批 | opencode 后端申请读取敏感文件时，飞书弹卡片让人点允许或拒绝 |
| 模型切换 | `/model`、`/agent` 在线切换，无需重启 |
| 排队与中止 | 同一会话上一条还在执行时，新消息排进队列；卡片上可引导、取消、`/stop` |
| 可换后端 | `opencode` 与 `pi` 内置；其他命令行 Agent 实现 `Backend` 接口后接入，共用卡片、会话、排队与中止逻辑 |
| 多机器人 | 多个飞书应用 + 多份配置 + 多个进程，各自精确判断「@ 的是我」 |

适用场景：人在外面用手机给本机 Agent 派活；多个本机 Agent 在同一个飞书群里分工。

边界：任务在本机执行，不提供云端执行沙箱。桥接进程退出后机器人停止响应，长期运行要装常驻服务。

---

## 工作原理

下面四张图用 Mermaid 绘制，GitHub 与多数 Markdown 预览可直接渲染。每张图后附设计说明。

### 图 1 · 系统架构

```mermaid
flowchart TB
  subgraph Cloud["飞书云"]
    U["用户 / 群聊"]
    API["开放平台 API"]
  end
  subgraph Bridge["桥接进程 · 一个机器人一个进程"]
    FT["feishu.js<br/>长连接 / 闸门 / 来源标注"]
    HD["handler.js<br/>命令 / 运行编排 / 队列 / 看门狗"]
    ST["store.js<br/>state.json"]
    BE["backend.js<br/>统一接口 / 能力声明"]
    RD["render.js → md.js → cards.js<br/>运行态 → 卡片 2.0"]
  end
  subgraph Agents["本地 Agent · 可替换"]
    OC["oc.js<br/>opencode serve"]
    PI["pi.js<br/>pi CLI 子进程"]
    NEW["自定义 Backend<br/>任意命令行 Agent"]
  end
  FS["本机项目目录 / shell / 文件"]
  AD["admin/ 管理后台"]
  CFG["配置目录 / 日志 / launchd"]

  U -->|发消息与点按钮| API
  API -->|长连接事件| FT
  FT --> HD
  HD <--> ST
  HD --> BE
  BE --> OC
  BE --> PI
  BE -.-> NEW
  OC --> FS
  PI --> FS
  NEW -.-> FS
  OC -->|SSE事件| RD
  PI -->|JSONL合成事件| RD
  NEW -.->|同形状事件| RD
  RD -->|节流patch| FT
  FT -->|创建与更新卡片| API
  API --> U
  AD -.-> CFG
  CFG -.->|启动时读取| HD
```

整个系统分三层。飞书云负责收发消息与卡片。桥接进程承担全部交互逻辑：消息闸门、命令、会话绑定、队列、卡片刷新、超时收尾。本地 Agent 只负责执行任务并产生事件。把执行层换成另一个命令行工具时，交互层的代码无需改动。

长连接由 `feishu.js` 主动建立，机器人主动连飞书，本机无需公网入口。`admin/` 是旁路，读写配置、查看日志、起停实例，不参与消息链路。

### 图 2 · 一条消息的执行时序

```mermaid
sequenceDiagram
    autonumber
    actor U as 飞书用户
    participant F as feishu.js
    participant H as handler.js
    participant S as state.json
    participant B as Backend
    participant A as 本地Agent
    participant C as 飞书卡片

    U->>F: 发文本或@机器人
    F->>F: 校验@判定、放行名单、消息去重
    F->>F: 拼来源标注与prompt前缀
    F->>H: onMessage
    H->>S: 读取会话绑定
    alt 无绑定
        H->>B: createSession
        B->>A: 建会话
        H->>S: 写入绑定
    end
    H->>C: 创建执行中卡片
    H->>B: prompt
    B->>A: 执行任务
    loop 事件持续到达
        A-->>B: 文本 / 工具 / 用量
        B-->>H: 统一事件
        H->>H: render.js聚合运行态
        H->>C: 串行patch
    end
    A-->>B: 执行结束
    B-->>H: 终态事件
    H->>S: 清除未收尾卡片记录
    H->>C: 终态卡片
```

四个关键点：

1. 闸门在飞书层。`@` 判定、放行名单、消息去重在进入 `handler.js` 之前完成。多个机器人同群时，只有被 @ 的那个会往下走。
2. `state.json` 保存会话绑定、排队消息、未收尾卡片。进程重启后，遗留卡片会被标成已中止。
3. 卡片刷新串行执行，间隔由 `behavior.streamIntervalMs` 控制。终态更新最后写入。
4. 同一会话上一条还在执行时，新消息排进队列，当前任务结束后自动发送。

### 图 3 · 后端为什么可以换

```mermaid
flowchart LR
  H["handler.js<br/>只认接口"] --> I["Backend 接口<br/>health / subscribe / createSession<br/>prompt / interrupt / listSessions ..."]
  I --> O["OpencodeClient<br/>src/oc.js"]
  I --> P["PiBackend<br/>src/pi.js"]
  I -.-> N["你的实现<br/>任意命令行 Agent"]
  O --> C1["capabilities<br/>streaming / agents / permissions"]
  P --> C2["capabilities<br/>oneShot"]
  N -.-> C3["capabilities<br/>按需声明"]
  C1 --> FE["飞书交互层<br/>按能力自动降级"]
  C2 --> FE
  C3 -.-> FE
  O --> EV["session.* 事件<br/>render.js 统一聚合"]
  P --> EV
  N -.-> EV
```

`handler.js` 只调用 `Backend` 接口上的方法，`backend.js` 按 `backend.type` 选择实现。两个现有实现的差别被藏在各自文件里：

- `oc.js` 连接常驻的 `opencode serve`，把 SSE 事件流交给 `render.js`。
- `pi.js` 每条消息起一次子进程，把 JSONL 输出翻译成 `session.*` 形状的**合成事件**，`render.js` 因此只有一套聚合逻辑。
- `capabilitiesFor()` 声明 `streaming`、`agents`、`permissions`、`oneShot`。声明为关闭的能力，`/agent`、权限审批卡片、流式刷新会自动降级。

接入步骤见[开发章节](#开发)。

### 图 4 · 群聊话题与会话绑定

```mermaid
flowchart TB
  G["同一个飞书群"] --> T1["话题A<br/>key = root:消息1"]
  G --> T2["话题B<br/>key = root:消息2"]
  G --> T3["新@主聊天流<br/>key = root:自身消息id"]
  T1 --> S1["会话1"]
  T2 --> S2["会话2"]
  T3 --> S3["会话3"]
  S1 --> Q["behavior.maxParallel<br/>整机并发上限"]
  S2 --> Q
  S3 --> Q
  Q --> L["本地 Agent 后端"]
```

群聊用话题根消息的 id 作绑定键，私聊用 `chat_id`。根消息来自 `root_id`，主聊天流里新 @ 的消息自身成为根，两种情况用同一个公式。多条话题各自绑定独立会话，`behavior.maxParallel` 限制整机同时执行的任务数。同一会话内部仍然串行，新消息排进队列。`state.json` 是绑定的唯一来源，飞书界面里的选中状态不参与判定。

### 模块职责

| 文件 | 职责 |
|---|---|
| `src/index.js` | 入口、单实例锁、`--dry` 终端模式、启动健康检查 |
| `src/config.js` | 配置目录解析、默认值、模板铺开、环境变量覆盖 |
| `src/feishu.js` | 飞书长连接收发、群聊 @ 判定、消息来源标注、卡片回传 |
| `src/handler.js` | 命令分发、会话绑定、运行编排、排队、卡片回调、看门狗 |
| `src/backend.js` | 后端工厂与统一能力声明 |
| `src/oc.js` | opencode v2 HTTP API 与 SSE 事件流客户端 |
| `src/pi.js` | pi 子进程、JSONL 事件翻译成合成事件、终端会话接入 |
| `src/render.js` | 事件聚合成运行态（正文、步数、用量） |
| `src/md.js` | Markdown 分段解析成飞书卡片元素 |
| `src/cards.js` | 卡片 2.0 模板 |
| `src/store.js` | `state.json` 读写、遗留字段清理、队列与未收尾卡片持久化 |
| `src/which-opencode.js` | 选择本机 opencode 可执行文件 |
| `src/github-*.js/.mjs` | GitHub App 身份注入与凭证助手 |
| `admin/*.js` | 本地管理后台的服务、实例发现、后端扫描、新建实例 |
| `scripts/*.sh` | 启动、停止、状态、launchd 常驻安装 |

三条设计约束，改代码前先读：

1. `handler.js` 只调用 `backend.js` 暴露的一组方法（`health`、`location`、`subscribe`、`createSession`、`prompt`、`interrupt`、`listSessions` 等）。后端差异留在 `oc.js`、`pi.js` 或新的实现文件内。
2. `state.json` 是会话绑定的唯一数据来源。私聊用 `chat_id` 作键，群聊用 `root:<话题根消息 id>` 作键。同一会话同时只跑一个任务。
3. 同一张卡片的多次刷新串行发出（`flushRun()`）。终态更新与最后一段文本常常同时到达，串行能保证终态最后生效。

---

## 信任边界与身份传递

下面两张图用纯文本绘制，任何 Markdown 预览都能显示。它们描述数据跨越边界时，凭证、身份与权限如何流动。

### 图 5 · 端到端信任边界

```
 [外部 / 飞书云]
 +------------------------------------------------------------------+
 |  用户 A     用户 B     其他机器人                                 |
 |      \        |        /     文本、@、卡片点击                    |
 |       +-------+-------+                                          |
 |                   v                                             |
 |    开放平台   im.message.receive_v1 / card.action.trigger        |
 +------------------------------|-----------------------------------+
                                | 长连接：桥接主动外连，TLS
                                | appId + appSecret -> tenant_access_token
 ================================|==================================== 信任边界
                                v
 [本机 / 桥接进程]   bridge.lock 保证单实例
 +------------------------------------------------------------------+
 | [闸门 1] @ 判定    mentions[].open_id == feishu.botOpenId        |
 | [闸门 2] 放行      allowlist U listen，open_id 按应用隔离         |
 | [闸门 3] 去重      message_id                                    |
 |                            |                                     |
 |   feishu.js --> handler.js --> store.js (state.json)             |
 |        ^             |                                           |
 |        |             v                                           |
 |   发卡片 / patch   backend.js                                    |
 |                        |                                         |
 | [闸门 4] 权限审批   session.permission.* -> 卡片 ->              |
 |                      once / always / reject -> replyPermission   |
 +------------------------|------------------------------------------+
                          | 注入本实例身份（启动时 / 每次任务）
      FEISHU_APP_ID / SECRET / DOMAIN
      LARKSUITE_CLI_CONFIG_DIR -> lark-cli/config.json (600)
      GH_TOKEN / GIT_AUTHOR_* / GIT_COMMITTER_*
      GIT_CONFIG_* -> github-app-credential.mjs
      PATH -> <配置目录>/bin/gh
                          v
 +------------------------------------------------------------------+
 | [本机 / 本地 Agent]    opencode serve   |   pi 子进程            |
 |     读写项目目录、执行 shell、调用模型、提交代码                  |
 +---------------|----------------------------|---------------------+
                 | 以本实例机器人身份发言      | 以 xxx[bot] 推送 / 开 PR
                 v                            v
            飞书（同一应用）               GitHub
```

四个身份域各自独立：

| 域 | 凭证 | 判定位置 |
|---|---|---|
| 人到桥接 | 飞书 `open_id` | `feishu.js` 的 @ 判定、`handler.js` 的 `isAllowed()` |
| 桥接到飞书 | `appId` / `appSecret` / `botOpenId` | `feishu.js` 建立长连接时 |
| 桥接到 Agent | 本实例飞书凭证与 GitHub 身份 | `pi.js` 的 `childEnv()` 或 `scripts/lib/*-identity.sh` |
| Agent 到外部 | `xxx[bot]` 的 token 与提交署名 | `src/github-identity.js` 的四路注入 |

多个机器人同机时，每个实例从自己的 `config.json` 读取凭证并注入自己的子进程，代理发言与代码提交都归属本实例应用。`open_id` 按应用隔离，填写错误时只会静默失效，放行名单变更后要到 `logs/bridge.log` 确认。

### 图 6 · 权限审批回路

```
  本地 Agent          handler.js          飞书卡片          人
      |                   |                  |              |
      | permission.asked  |                  |              |
      |------------------>|  sendCard        |              |
      |                   |----------------->|  允许一次     |
      |                   |                  |  总是允许     |
      |                   |                  |  拒绝         |
      |                   |                  |<--- 点击 -----|
      |                   | card.action.trigger             |
      |                   |<-----------------|              |
      | replyPermission(sessionID, requestID, once|always|reject)
      |<------------------|                  |              |
      |  继续执行 / 拒绝   |                  |              |
```

`session.permission.*` 事件进入 `handler.js` 后立刻推卡片，不走流式聚合。按钮回调携带 `a=perm`、`s`（会话）、`r`（请求）、`d`（决策），`handler.js` 校验 `caps.permissions` 后调用 `replyPermission()`。pi 后端声明 `permissions: false`，这条回路整条关闭。

### 凭证落盘

| 路径 | 内容 | 保护方式 |
|---|---|---|
| `~/.config/opencode-feishu-bridge/config.json` | `appSecret`、serve 密码、GitHub 身份 | 仓库外；`.gitignore` 再拦一道 |
| `state.json` | 会话绑定、排队消息、未收尾卡片 | 仓库外 |
| `bridge.lock` | 单实例锁与进程号 | 仓库外 |
| `lark-cli/config.json` | 只含本实例应用的凭证 | 写入时权限 600 |
| `github-app.pem` | GitHub App 私钥 | 建议权限 600 |
| `logs/*.log` | 运行日志 | `.gitignore` 排除 |

### 管理后台的边界

`admin/` 只监听 `127.0.0.1`。`requestGuards()` 校验 Host 属于 `localhost` 或 `127.0.0.1`，写操作额外要求 `Content-Type: application/json` 与 `X-OCB-Admin: 1`。这套校验用于阻挡跨站表单。响应里的 `appSecret` 与 `opencode.password` 一律掩码；写配置时密钥留空表示保持原值，并先备份成 `config.json.bak`。

### 边界上的薄弱处

| 位置 | 现状 | 后果 |
|---|---|---|
| `feishu.allowlist` 默认空 | 不限制私聊发送者 | 能找到机器人的人都能让它执行本机 shell |
| `botOpenId` 取不到 | 退化成「@ 任何人都响应」 | 多机器人同群会一起抢答 |
| 本地 Agent | 直接读写项目目录与 shell | 缺少沙箱与命令审计 |
| 管理后台 | 只做本地回环与跨站防护 | 本机任意进程都能调用写接口 |
| 凭证 | 明文落在配置目录 | 依赖文件系统权限与磁盘加密保护 |

---

## 环境与依赖

| 项目 | 要求 |
|---|---|
| Node.js | `>= 20`（`package.json` 的 `engines`） |
| 飞书 | 企业自建应用，启用机器人能力，使用长连接接收事件与回调 |
| opencode 后端 | 桌面版 OpenCode.app 自带的 CLI（推荐），或 PATH 里的 `opencode` |
| pi 后端 | 可执行的 `pi` CLI |
| macOS | 可选。launchd 常驻服务依赖 macOS；其他系统用 `npm start` 保持前台运行 |

桌面版自带 CLI 与 App 版本相同，共用同一个会话数据库。混用另一个 npm 全局版本会出现某些会话读不出历史：

```bash
which opencode && npm rm -g @opencode/cli
```

---

## 快速开始

### 1. 安装依赖

```bash
git clone <本仓库地址> && cd opencode-feishu-bridge
npm install
```

### 2. 确认使用哪份 opencode

使用 pi 后端或自定义后端时跳过本节。这类后端每条消息起一次子进程，不需要 opencode serve。使用 opencode 后端时，`scripts/up.sh` 按以下顺序选择可执行文件：

```
OPENCODE_BIN 环境变量  →  桌面版自带 CLI  →  PATH 里的 opencode
```

```bash
node scripts/which-opencode.mjs --json     # 查看选中的路径、版本、来源
```

`serve` 由 `up.sh` 自动拉起。手工调试时密码要与配置里的 `opencode.password` 一致：

```bash
OPENCODE_SERVER_PASSWORD='my-secret-123' \
  "$(node scripts/which-opencode.mjs)" serve --port 19876 --hostname 127.0.0.1

curl -s -u opencode:my-secret-123 http://127.0.0.1:19876/api/info
```

端口要与 `opencode.url` 一致。

### 3. 创建飞书应用

打开 <https://open.feishu.cn/app> → **创建企业自建应用**。

**3.1 添加机器人能力**：「添加应用能力」→ 机器人 → 启用。

**3.2 添加权限**：「开发配置 → 权限管理」→ 搜索并添加：

| 权限 | 用途 |
|---|---|
| `im:message` | 收发消息、更新卡片 |
| `im:message:send_as_bot` | 以应用身份发消息 |
| `im:message.p2p_msg:readonly` | 读取私聊消息 |
| `im:message.group_at_msg:readonly` | 读取群里 @ 机器人的消息 |
| `im:chat:readonly` | 可选，读取群名称 |
| `im:chat.members:read` | 可选，读取群成员名字 |

**3.3 订阅事件**：「事件与回调 → 事件配置」→ 订阅方式选 **使用长连接接收事件** → 添加 `im.message.receive_v1`。

**3.4 订阅卡片回调**：同一页面切到「回调配置」→ 订阅方式选 **使用长连接接收回调** → 添加 `card.action.trigger`。部分控制台把这一项放在「事件配置」里，名称叫「卡片回传交互」。漏掉这一步，卡片按钮会一直转圈。

**3.5 发布版本**：「版本管理与发布」→ 创建版本 → 申请发布。企业自建应用通常需要管理员审批；权限变更后必须重新发版。

**3.6 复制凭证**：「凭证与基础信息」→ App ID（`cli_` 开头）与 App Secret。

### 4. 初始化配置

配置目录按以下顺序解析，第一个命中的生效：

| 优先级 | 位置 |
|---|---|
| 1 | `$OCB_CONFIG_DIR` |
| 2 | `~/.config/opencode-feishu-bridge/` |

`npm start`、`scripts/*.sh`、`scripts/probe-*.mjs` 共用这套解析规则。配置放在仓库外，`appSecret` 不进入工作树。

```bash
npm run init                                        # 交互向导
npm run init -- --app-id=cli_xx --app-secret=yy     # 传入凭证，只问剩余项
npm run init -- --no-input                          # 只铺模板，适合 CI
npm run init -- --force                             # 覆盖现有配置，先备份成 .bak
npm run init -- --add-allow=ou_你的openid           # 往现有配置追加白名单
```

向导会验证凭证、自动填入 `feishu.botOpenId`、写入你的 `open_id` 白名单。配置已存在时默认不覆盖。

配置目录内的文件全部由本机生成：

| 文件 | 生成者 | 内容 |
|---|---|---|
| `config.json` | `npm run init` 或首次 `npm start` | 配置，含 `appSecret` |
| `state.json` | 桥接 | 会话绑定、排队消息、未收尾卡片 |
| `bridge.lock` | 桥接 | 单实例锁，写入进程号 |
| `pi-sessions/` | pi 后端 | 会话索引与 JSONL 记录 |

最小可用配置（模板全文见 `config.example.json`）：

```json
{
  "feishu": {
    "appId": "cli_a1b2c3d4e5f6g7h8",
    "appSecret": "你的 App Secret",
    "domain": "feishu",
    "allowlist": ["ou_你的open_id"],
    "requireMention": true,
    "botOpenId": "ou_机器人自己的open_id"
  },
  "opencode": {
    "url": "http://127.0.0.1:19876",
    "password": "my-secret-123",
    "defaultDirectory": "/Users/you/project",
    "defaultModel": "stepfun-step-plan/step-3.5-flash"
  }
}
```

两项要点：

- `opencode.defaultModel` 填 `providerID/modelID`。opencode 默认模型在部分地区会报 `RegionError`。列出可用模型：

  ```bash
  curl -s -u opencode:my-secret-123 http://127.0.0.1:19876/api/model \
    | python3 -c "import sys,json;[print(f\"{m['providerID']}/{m['id']}\") for m in json.load(sys.stdin)['data']]"
  ```

- `feishu.allowlist` 空数组表示任何人私聊机器人都能操作本机文件与 shell。先留空启动一次，给机器人发消息后从日志取得自己的 `open_id`，再执行 `npm run init -- --add-allow=ou_你的openid`。

### 5. 体检

```bash
npm run doctor
```

检查 Node 版本、`config.json` 完整性、凭证格式、白名单、opencode 可执行文件版本一致性、serve 连通性、模型与 agent 列表、`defaultModel` 是否在列表内、默认目录是否存在、状态文件概要。存在失败项时退出码为 1。

### 6. 启动

推荐装成 launchd 常驻服务：登录自启、进程退出后自动拉起、不依赖终端。

```bash
./scripts/install-agent.sh     # 安装一次
./scripts/status.sh            # 状态、运行时长、最近日志
./scripts/up.sh                # 重启（launchd 模式下执行 kickstart）
./scripts/down.sh              # 暂停（下次 up.sh 或下次登录会启动）
./scripts/uninstall-agent.sh   # 卸载
```

不装服务也能用，`up.sh` 会以 `nohup` 方式同时拉起 `serve` 与桥接：

```bash
npm run up        # 等同于 ./scripts/up.sh
npm run down      # 等同于 ./scripts/down.sh
npm start         # 前台运行，日志打到 stdout，适合调试
```

`up.sh` 会读取配置里的 `opencode.password`，用同一密码启动 serve。看到 `✅ 桥接已就绪` 后，在飞书里私聊机器人发 `/help`。

注意：

- 桥接有单实例锁（`bridge.lock`）。第二个进程会直接退出，避免同一条消息被回两遍。
- 桌面版 OpenCode App 无需常开。桥接用的是 App 安装在磁盘上的 CLI。升级桌面版后执行 `./scripts/down.sh && ./scripts/up.sh`，让 serve 换到新版本 CLI。
- `nohup` 起的进程挂在某个 shell 的进程组里，该 shell 退出时可能一起被收掉。长期运行用 `install-agent.sh`。

### 7. 无飞书验证

```bash
npm run dry
```

终端 REPL，把飞书换成 stdin，卡片渲染成 ASCII 框。会话创建、流式事件、命令分发与真机一致。输入 `/help` 看命令，`/quit` 退出。

---

## 配置

`config.example.json` 是唯一模板，`src/config.js` 的 `DEFAULTS` 提供缺省值。文件配置覆盖默认值，环境变量覆盖文件配置。配置在进程启动时读取，修改后重启实例生效。

### 字段

| 键 | 说明 | 默认值 |
|---|---|---|
| `backend.type` | `opencode` 或 `pi` | `opencode` |
| `backend.pi.bin` | pi CLI 路径 | `pi` |
| `backend.pi.model` | 传给 `--model`，留空用 pi 的默认值 | `""` |
| `backend.pi.timeoutMs` | 子进程静默多久判定超时，每吐一行 stdout 重置 | `600000` |
| `backend.pi.settleQuietMs` | 最终回答后静默多久按已完成收尾，`0` 关闭此机制 | `180000` |
| `backend.pi.extraArgs` | 额外启动参数，例如 `["--no-extensions"]` | `[]` |
| `backend.pi.cliSessionRoot` | 终端 `pi -r` 会话根目录 | `~/.pi/agent/sessions` |
| `feishu.appId` / `feishu.appSecret` | 应用凭证 | `""` |
| `feishu.domain` | `feishu` 或 `lark` | `feishu` |
| `feishu.allowlist` | 放行名单，空数组表示不限制 | `[]` |
| `feishu.listen` | 单向放行名单。A 的 `listen` 含 B 时，B 的 @ 能唤醒 A | `[]` |
| `feishu.requireMention` | 群里是否必须 @ 本机器人才响应 | `true` |
| `feishu.botOpenId` | 机器人自身 open_id。留空则启动时向飞书查询 | `""` |
| `feishu.names` | `open_id → 显示名`，用于消息来源标注 | `{}` |
| `opencode.url` | serve 地址 | `http://127.0.0.1:19876` |
| `opencode.password` | serve 密码，与 `OPENCODE_SERVER_PASSWORD` 一致 | `""` |
| `opencode.defaultDirectory` | `/new` 不带目录时使用；pi 每次执行也起在该目录 | `$HOME` |
| `opencode.defaultModel` | `providerID/modelID`，建议显式填写 | `""` |
| `github.mode` | `off` / `app` / `pat`，控制 GitHub 身份注入 | `off` |
| `github.appId` / `installationId` / `privateKeyPath` | GitHub App 身份参数 | `""` |
| `github.token` | `pat` 模式使用的个人访问令牌 | `""` |
| `github.gitName` / `github.gitEmail` | 提交署名 | `""` |
| `behavior.streamIntervalMs` | 卡片刷新间隔，低于 1200 会被飞书限流 | `1800` |
| `behavior.showReasoning` | 是否在卡片展示思考过程 | `false` |
| `behavior.showTools` | 是否展示工具调用链路 | `false` |
| `behavior.maxBodyChars` | 卡片正文字符上限，超出保留尾部 | `6000` |
| `behavior.idleTimeoutMs` | 仅 opencode 后端：多久没有事件就判定卡死并收尾，`0` 关闭 | `300000` |
| `behavior.maxParallel` | 整机同时运行的任务数，`0` 表示不限 | `2` |
| `prompt.prefixes` | 发给模型的文本前缀数组，条目含 `id`、`mode`（`once` / `always`）、`text` | `[{ "id": "rules", "mode": "once", "text": "" }]` |

### 环境变量

| 变量 | 作用 |
|---|---|
| `OCB_CONFIG_DIR` | 指定配置目录，多实例必需 |
| `OCB_INSTANCE` | launchd 服务名后缀，多实例必需 |
| `OCB_BACKEND` / `OCB_PI_BIN` / `OCB_PI_MODEL` | 覆盖后端类型、pi 路径、pi 模型 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_DOMAIN` | 覆盖飞书凭证与域名 |
| `OPENCODE_URL` / `OPENCODE_SERVER_PASSWORD` | 覆盖 serve 地址与密码 |
| `OPENCODE_BIN` | 指定 `up.sh` 使用的 opencode 可执行文件 |
| `BRIDGE_DEFAULT_DIR` / `BRIDGE_DEFAULT_MODEL` | 覆盖默认目录与默认模型 |
| `BRIDGE_ALLOWLIST` | 逗号分隔的白名单 |
| `BRIDGE_NODE` | `install-agent.sh` 写入 plist 的 node 路径 |
| `OCB_SDK_TIMEOUT_MS` | 飞书 SDK 请求超时，默认 20000 |
| `PORT` | 管理后台监听端口，默认 19877 |

### 密钥

`config.json` 含 `appSecret`，`state.json` 含本机会话绑定，两者都在仓库外。`.gitignore` 排除 `.config/` 作为第二道防线。不要执行 `git add -f` 把它们加入仓库。管理后台保存配置时，密钥字段留空表示保持原值，并自动备份成 `config.json.bak`。

---

## 飞书里怎么用

一条请求对应一条消息。发文本会新开一张卡片承载本次执行，流式刷新发生在这张卡片内部。点「会话列表」「切换」「新会话」「授权」会新发一条卡片，历史回复保持原样。列表翻页只更新列表卡片自己。

### 命令

| 命令 | 作用 |
|---|---|
| 直接发文本 | 发给当前绑定会话，没有绑定时自动创建 |
| `/help` | 命令列表 |
| `/new [目录]` | 新建会话并绑定 |
| `/sessions` | 会话列表卡片，点按钮切换 |
| `/switch <序号\|id>` | 文本方式切换会话 |
| `/rename <标题>` | 重命名当前会话 |
| `/del <序号>` | 删除会话 |
| `/cd <目录>` | 换工作目录并重置绑定 |
| `/stop` | 中止当前执行 |
| `/status` | 查看绑定、模型、token、成本 |
| `/model` / `/model <序号>` | 列出模型 / 切换模型 |
| `/agent` / `/agent <名字>` | 列出 agent / 切换 agent（仅 opencode 后端） |

别名：`/ls` = `/sessions`，`/use` = `/switch`，`/abort` = `/stop`，`/delete` = `/del`，`/?` = `/help`。

### 群聊规则

- 群里每 @ 一次开一条话题，并为这条话题建立独立会话。多条话题可以并行，整机上限由 `behavior.maxParallel` 控制。
- 话题内继续说话仍需 @ 本机器人，消息会接在同一条话题的会话上。
- @ 判定按 `open_id` 精确比对。`feishu.botOpenId` 显式填写后，多机器人同群时只响应 @ 自己的消息；取不到自身 open_id 时会退化成「@ 任何人都会响应」，启动日志会给出告警。
- 没有 @ 的消息在进入处理流程前直接丢弃，模型看不到它。被 @ 的是别人时，日志记一行 `[skip]`，带被 @ 者的名字。
- 占位符处理：@ 本机器人的占位符被删掉，@ 别人的占位符还原成 `@姓名`，模型能看见这句话在跟谁说。
- 每条消息前拼一行来源标注，包含群名或私聊、主聊天流或话题内、发送者完整 `open_id`、人还是机器人、时间。名字来自 `feishu.names` 或群成员接口（`im:chat.members:read`）；两者都没有时只显示 `open_id`。

放行闸门取 `feishu.allowlist` 与 `feishu.listen` 的并集，由人在配置或管理后台维护。`open_id` 按应用隔离，填写错误时只会静默失效，加完去看 `logs/bridge.log` 是否出现「拒绝非白名单用户」。

### 排队

同一会话同时只跑一个任务。上一条还在执行时，新消息默认排进 follow-up 队列，当前任务结束后自动发送，卡片会显示排在第几位。「引导」会中止当前任务并把这条消息插到队首；「取消」把它从队列移除。队列落在 `state.json` 里，桥接重启后保留。

### 卡片渲染

| Markdown | 飞书组件 |
|---|---|
| 表格 | 原生表格，表头灰底，超过 10 行飞书内部分页 |
| 围栏代码块 | 带语法高亮的 `markdown` 组件 |
| `## 标题` | 加粗正文 |
| `- 列表` / `> 引用` | 圆点列表 / 普通正文 |
| 加粗、斜体、行内代码、链接 | 原样支持 |

单张卡片上限 30KB，超大表格裁剪到 50 行 8 列。卡片分三段：前缀（目录 / 模型 / 耗时 / 步数）、正文、后缀（用量小字与按钮）。正文按助手叙述的段累加，段间空一行。金额保留两位小数；部分模型提供商在 `/api/model` 里把成本填 0，此时显示 `$0.00`。

---

## 执行后端与多实例

### 能力矩阵

| 能力 | opencode 后端 | pi 后端 |
|---|---|---|
| 执行方式 | 常驻 `opencode serve`，HTTP + SSE | 每条消息起一次 `pi -p --mode json` 子进程 |
| 流式正文 | 原生事件流 | 把 JSONL 事件翻译成同形状的合成事件 |
| 卡片、节流、中止、僵尸卡收尾 | 共用 | 共用 |
| 权限审批卡片 | 支持 | 不支持 |
| `/agent` | 支持 | 不支持 |
| 会话 | 由 serve 管理，接口查询 | `<配置目录>/pi-sessions/` 的索引与 JSONL；兼容终端 `pi -r` 会话 |
| 卡死判定 | `behavior.idleTimeoutMs` | `backend.pi.timeoutMs` 与 `backend.pi.settleQuietMs` |

pi 的 `/sessions` 同时列出桥接会话与终端 `pi -r` 会话。切到终端会话后走 `pi --session <文件>` 续聊，两端读写同一个 JSONL。终端会话的改名、删除、切模型由 pi 自己管理，桥接会明确拒绝这三个操作。

### 多实例

一个机器人 = 一个飞书应用 + 一份配置 + 一个进程。第二个实例用 `pi` 后端时：

```bash
mkdir -p "$HOME/.config/opencode-feishu-bridge-pi"
OCB_CONFIG_DIR="$HOME/.config/opencode-feishu-bridge-pi" npm run init
# 编辑该目录的 config.json：backend.type = pi，填入新应用的凭证
./scripts/install-agent.sh --instance pi --config-dir "$HOME/.config/opencode-feishu-bridge-pi"
OCB_INSTANCE=pi npm run status
OCB_INSTANCE=pi npm run up
```

`OCB_CONFIG_DIR` 决定读哪份配置，`OCB_INSTANCE` 决定 launchd 服务名。后续重启、查看状态都要带同一个 `OCB_INSTANCE`。`install-agent.sh` 会按 `backend.type` 决定是否安装 serve 服务。管理后台的「新建实例」弹窗可以代替上述命令。

### 身份注入

飞书身份与 GitHub 身份各有一层注入，保证多个 agent 同机时发言、提交都用自己的应用：

- pi 后端：起子进程前由 `src/pi.js` 的 `childEnv()` 注入。
- opencode 后端：代理跑在常驻 serve 里，注入点放在 serve 启动处（`scripts/agent/serve.sh` 与 `scripts/up.sh`）。
- 注入内容：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_DOMAIN`、本实例的 `lark-cli` 配置目录、GitHub 的 `GH_TOKEN` 与提交署名与 git 凭证助手与 `gh` 包装脚本。
- 配置里没有凭证时不注入，沿用机器级配置。身份在进程启动时读取，改配置后重启 serve（opencode）或等下一次任务（pi）即跟随。

`github` 段的完整字段、App 创建步骤、token 刷新机制与排障命令见 [docs/pi-backend.md 第 6.1 节](docs/pi-backend.md#61-github-身份github-段)。`prompt.prefixes` 的 `once` / `always` 语义与拼装顺序见[第 6.2 节](docs/pi-backend.md#62-prompt-前缀prompt-段)。

已知风险：机器人之间互相 @ 没有轮次护栏。多个 agent 同群协作时，机器人可能连续聊好几轮，目前靠模型自己判断停止。

---

## 本地管理后台

零新增依赖的浏览器界面，用 node 内置模块起服务，界面是单页原生 HTML/JS，没有构建步骤。

```bash
npm run admin                # 监听 127.0.0.1:19877
npm run admin -- --port 8080 # 换端口
```

打开 <http://127.0.0.1:19877>。

| 页面 | 功能 |
|---|---|
| 总览 | 实例状态、后端类型、配置目录、pid 与运行时长、serve 版本、会话数与进行中卡片数；已装 launchd 服务时可启动、停止、重启 |
| 配置 | 按实例编辑 `config.json`；后端选项来自本机扫描；密钥掩码显示，留空保持原值 |
| 飞书应用 | 校验凭证、管理 `allowlist` / `listen` / `names` |
| 会话与后端 | serve 健康、模型列表、会话列表、`state.json` 只读展示、pi CLI 版本 |
| 日志与体检 | `bridge.log` / `serve.log` 增量跟随；按实例运行 `doctor` |
| 新建实例 | 三步生成配置、自动分配 serve 端口与密码、安装 launchd 服务并启动；失败自动回滚 |

接口以 `/api/instances` 与 `/api/backends` 为入口，子路径包含 `config`、`allowlist`、`names`、`listen`、`action`、`logs`、`doctor`、`feishu-verify`、`sessions`、`models`。

安全边界：只监听 `127.0.0.1`；Host 头只接受 `localhost` 与 `127.0.0.1`；接口只收 `application/json`；写操作额外要求 `X-OCB-Admin: 1`；密钥不回传浏览器、不写入后台日志；起停操作只对已装 launchd 服务的实例开放。

代码在 `admin/`：`server.js`（服务与接口）、`instances.js`（实例发现）、`backends.js`（本机扫描）、`create.js`（新建实例）、`control.js`（起停、体检、日志）、`entries.js`（名单操作）、`public/index.html`（界面）。

---

## 开发

### 目录

```
config.example.json        配置模板（可入库）
src/                       桥接主体，ESM
admin/                     本地管理后台
scripts/                   初始化、体检、启动、测试、探针
  ├── agent/serve.sh       launchd 路径启动 serve
  ├── agent/bridge.sh      launchd 路径启动桥接
  └── lib/*.sh             配置目录、身份注入、launchd PATH
docs/                      设计笔记、pi 后端方案、运维方案、截图
logs/                      运行日志（不入库）
```

### 验证

下表中斜杠后的名称沿用同一个 `npm run` 前缀。

| 命令 | 覆盖范围 |
|---|---|
| `npm run doctor` | 本机环境与配置完整性 |
| `npm run dry` | 无飞书的终端 REPL，全链路模拟 |
| `OC_PW=<密码> npm run selftest -- --model <providerID/modelID>` | 真实模型集成自测：建会话、发 prompt、删会话、流式聚合、卡片回调、白名单、@ 判定 |
| `npm run test:render` / `test:patch` | 卡片渲染与 patch 顺序 |
| `npm run test:busy` / `test:runfail` / `test:wedge` | 排队、运行失败、看门狗收尾 |
| `npm run test:pi` / `test:pi-cli-sessions` | pi 后端与终端会话 |
| `npm run test:admin` / `test:init` / `test:identity` / `test:github` / `test:serve-password` | 后台、初始化、身份注入、serve 密码 |
| `npm run probe:names [chat_id]` / `probe:msg` | 飞书接口探针，打印权限与字段 |

`scripts/test-cards.mjs` 与 `scripts/probe-thread.mjs` 没有对应的 npm 脚本，用 `node <路径>` 运行。

`selftest` 需要 serve 正在运行，会真实创建与删除会话。跑测试前确认配置指向测试用的实例。

### 接入新的本地 Agent

`handler.js` 只认接口方法。把任何能在本机执行任务、能输出进度的命令行 Agent 接进来，需要实现下表方法，并让 `subscribe()` 吐出 `session.*` 形状的事件。事件类型清单在 `src/render.js` 的 `switch` 里。

| 方法 | 作用 |
|---|---|
| `health()` | 启动时检查后端可用，返回版本信息 |
| `location()` | 返回当前工作目录 |
| `subscribe(onEvent, onStatus)` | 注册事件流，返回取消订阅的函数 |
| `createSession()` / `getSession()` / `listSessions()` | 建立、读取、列出会话 |
| `renameSession()` / `deleteSession()` | 改名与删除会话 |
| `prompt(sessionId, text)` | 发送一次任务，进度通过事件流回传 |
| `interrupt(sessionId)` | 中止当前执行 |
| `listModels()` / `defaultModel()` / `switchModel()` | 支撑 `/model` |
| `listAgents()` / `switchAgent()` | 支撑 `/agent` |
| `replyPermission()` / `listMessages()` | 权限审批与消息读取 |

不支持的方法返回空列表或明确拒绝，并在 `capabilitiesFor()` 里关掉对应能力。`src/pi.js` 就是这样处理 agent 与权限审批的。

步骤：

1. 在 `src/` 新建实现文件。事件形状按 `src/render.js` 输出，常用类型有 `session.execution.started`、`session.text.delta`、`session.tool.called`、`session.usage.updated`、`session.execution.succeeded` / `failed` / `interrupted`。
2. 在 `src/backend.js` 的 `createBackend()` 注册新类型，在 `capabilitiesFor()` 声明 `streaming`、`agents`、`permissions`、`oneShot`、`label`。
3. `handler.js` 无需改动。卡片、命令、状态、排队逻辑按能力声明自动降级。
4. 在 `admin/backends.js` 的 `scanBackends()` 加入本机探测，管理后台才会显示这个选项。
5. 补一份 `scripts/test-*.mjs`，并在 `package.json` 里加脚本入口。
6. `scripts/up.sh` 与 `scripts/install-agent.sh` 只在 `backend.type = opencode` 时拉起 serve。一次性命令行后端沿用这条分支，无需改脚本。

### 调试与日志

前台运行 `npm start` 时日志打到 stdout。后台运行看 `logs/bridge.log` 与 `logs/serve.log`。`npm run status` 会打印进程状态、版本一致性与最近三行桥接日志。

群消息会记一行原始上下文（`chat`、`key`、`thread`、`root`、`parent`、消息 id）。排查话题串线时先看这行。被 @ 判定拦下的消息会记 `[skip]` 行。

---

## 排障

| 现象 | 处理 |
|---|---|
| 启动报 `连不上 opencode serve` | 确认 serve 已启动、端口与密码一致：`curl -u opencode:密码 http://127.0.0.1:19876/api/info` |
| 报 401 | `opencode.password` 与 serve 启动时的密码不一致。用 `up.sh` 启动会自动带入配置值；改过密码要重启 serve |
| 飞书发消息没反应 | 检查应用是否发布、权限是否审批、事件订阅是否选「长连接」、`im.message.receive_v1` 是否添加 |
| 卡片按钮一直转圈 | 「回调配置」漏加 `card.action.trigger` |
| 群聊不回 | 检查是否 @ 了本机器人、机器人是否已入群、日志里是否有 `[skip]` 行、事件是否到达 |
| 报 `RegionError` | `defaultModel` 用了本地区不可用的模型，换一个 |
| 会话一秒内失败，错误含 `Failed to decode message` | 会话历史由另一个 opencode 版本写入。先跑 `npm run doctor` 看版本，再读 [design-notes 的历史数据兼容一节](docs/design-notes.md#opencode-升级后的历史数据兼容问题) |
| 卡片不更新 | `streamIntervalMs` 过低被限流，调回 1800 |
| 卡片一直停在「执行中」 | 看 `logs/bridge.log` 的事件流断开记录；opencode 靠 `idleTimeoutMs` 收尾，pi 靠 `settleQuietMs` 收尾；桥接重启后遗留卡片会被标成「已中止」 |
| 同一条消息回两遍 | 跑了两个桥接进程。执行 `./scripts/down.sh` 全部停止，再 `./scripts/up.sh` |
| 机器人突然停止响应且日志无报错 | `nohup` 进程被外部回收。执行 `./scripts/status.sh` 确认，改装 `install-agent.sh` |
| 提示「已经有 N 个任务在跑」 | 到达 `behavior.maxParallel` 上限，本机资源允许时调到 3–4 |
| 后台返回 403 | Host 头只接受 `localhost` 与 `127.0.0.1`，用这两个地址直接访问 |
| 改了配置不生效 | 配置在进程启动时读取，重启实例 |

---

## 已知限制

1. 只处理文本消息。图片、文件、语音会回一句「暂不支持」。
2. 同一会话任务串行，新消息排队等待。
3. 卡片刷新有 1～2 秒间隔，飞书 patch 接口存在频率限制。
4. 桥接进程必须存活。合盖休眠、断网、关终端都会让机器人失效，长期运行要装常驻服务。
5. 同一条话题里所有人共用一个会话绑定，隔离粒度是话题。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [README.full.md](README.full.md) | 完整版说明：产品截图、卡片渲染细节、管理后台逐步操作、多机器人协作、排障全集 |
| [docs/design-notes.md](docs/design-notes.md) | 实现笔记：飞书卡片 2.0 的坑、状态与并发、opencode 版本一致性、群聊话题模型 |
| [docs/pi-backend.md](docs/pi-backend.md) | pi 后端方案：合成事件、会话、超时、GitHub 身份、prompt 前缀、事故复盘 |
| [docs/tmux-ops.md](docs/tmux-ops.md) | tmux 运维层方案与验收标准 |
| [docs/images/NOTICE.md](docs/images/NOTICE.md) | 产品截图的脱敏处理说明 |
