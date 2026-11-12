# 会话查看与删除（管理后台「会话与后端」页）需求规格

> 状态：已实现
> 日期：2026-11-12
> 交付提交：`476e4b8`（PR #43）
> 需求来源：邱琪光，飞书群「桥接话题探针」
> 关联代码：`admin/public/index.html`、`admin/server.js`、`src/store.js`、`src/pi.js`
> 实现笔记：[design-notes.md 第十六节](design-notes.md)、`src/oc.js`

---

## 1. 需求上下文

原话一：

> 桥接admin的「会话与后端」中，有显示绑定很多会话，但是没有提供查看和删除按钮，这块需要新起一个需求

原话二（对两个操作形态的明确要求）：

> 查看的话，我是希望打开访达查看就好了，删除的话就是删除本地文件

「会话与后端」页有三张表：进行中的卡片、飞书绑定、后端会话。三张表都是只读渲染。需求是给「飞书绑定」与「后端会话」两张表补上查看与删除，形态按原话二：查看在访达里打开，删除删本地文件。

## 2. 现状与问题

### 2.1 两个后端的会话存储方式不同

| 后端 | 会话数据在哪 | 访达里能看到什么 | 删除的正确方式 |
|---|---|---|---|
| pi | 配置目录下 `pi-sessions/index.json`（索引）加 `<时间戳>_<id>.jsonl`（每条会话一个文件） | 每条会话一个文件，可直接打开 | 删 jsonl 文件，删索引条目 |
| opencode | 常驻 serve 的 SQLite 数据库 `~/.local/share/opencode/opencode.db`（design-notes 第八节） | 只有数据库文件，没有单会话文件 | serve 的 `DELETE /api/session/:id`（`src/oc.js` 已有 `deleteSession()`） |

本机实例：lil-o 是 opencode 后端（serve 2.2.7，127.0.0.1:19876），lil-p 是 pi 后端。需求覆盖两个后端，「查看」与「删除」的具体动作按上表分流。

实测确认：serve 的 `/api/location` 只返回 `directory` 与 `project`，不返回数据库路径。opencode 的数据库位置按 design-notes 第八节的已知路径取。

### 2.2 删除绑定与桥接进程的关系

飞书绑定存在 `state.json` 的 `chats` 里。桥接进程是这个文件的唯一写者：`Store` 全量持有内存数据，任何变更经 300ms 防抖后整文件落盘（`src/store.js` 的 `scheduleSave()` / `flush()`）。admin 直接改 `state.json` 删掉一个绑定，桥接下一次 flush 就会把它写回来。

`config.json` 能走「admin 写、重启生效」，因为桥接只读配置；`state.json` 相反，桥接是全量写者，这条路走不通。

### 2.3 进行中的会话不能删

`state.json` 的 `inflight` 里在跑的会话，删掉后端数据后事件流没有归宿，飞书卡片会永远停在「执行中」；pi 的子进程还会继续往已删除的 jsonl 写。

## 3. 目标与非目标

**目标**

- G1 飞书绑定表每行可查看（在访达打开它绑定的会话）、可解除绑定（从 state.json 移除该 key）。
- G2 后端会话表每行可查看（在访达打开会话文件或数据库目录）、可删除（pi 删文件与索引条目，opencode 调 serve 删除）。
- G3 解除绑定对运行中的桥接生效，不被覆写。
- G4 删除后端会话时，同步清掉指向它的绑定（清 `sessionId`，保留记录与目录）。
- G5 进行中的会话拒绝删除；改 `state.json` 前备份；删除有确认，后果写清。

**非目标**

- 不做消息阅读器，不做会话导出。
- 不改「进行中的卡片」表的交互。那张表的语义是收尾中的卡片，不是可管理的数据。
- 不改 `/sessions`、`/switch`、`/new`、`/del` 等飞书命令的行为。
- 不做批量删除，不做定时清理。

## 4. 决策记录

| # | 议题 | 决策 | 理由 |
|---|---|---|---|
| D1 | 查看的实现 | admin 起 `open` 命令：文件用 `open -R`（在访达里选中该文件），目录用 `open` | 用户明确要求在访达里看。admin 跑在本机回环，spawn 一个 `open` 即可，页面不需要渲染消息 |
| D2 | 查看的后端分流 | pi 打开会话 jsonl 文件；opencode 打开 `~/.local/share/opencode` 目录 | pi 的会话本来就是文件。opencode 的会话是数据库里的行，没有单会话文件，只能打开数据库所在目录 |
| D3 | 删除的后端分流 | pi 删 jsonl 文件加改 `index.json`；opencode 调 serve 的删除接口 | 两个后端的数据所有者不同：pi 是文件，opencode 是 serve。`src/oc.js` 已有 `deleteSession()`，admin 复用一个 HTTP 调用，删的是本地数据库里的行 |
| D4 | 解除绑定如何到达运行中的桥接 | 桥接侧单向同步：`state.json` 发生外部改动时，把「磁盘上已不存在的绑定」从内存删掉；每次 flush 落盘前也先做一次同步 | 删除意图用「磁盘真相」表达，admin 与桥接之间不需要命令协议。单向同步只传播删除，不碰桥接自己的新增，排队消息等运行时状态不受影响。flush 前同步关闭「admin 刚删完、桥接的防抖 flush 随即将旧内存写回」的窗口 |
| D5 | 删后端会话后绑定怎么处理 | 清掉绑定的 `sessionId`，保留整条记录 | 目录等信息还在，下一次 @ 在同一目录新建会话。与 `/del` 的既有行为一致（`cmdDelete()` 里 `store.clearSession()`） |
| D6 | 进行中的会话 | 拒绝删除，接口返回 400 与可读原因 | 见 2.3 |
| D7 | 备份 | 改 `state.json` 前备份为 `state.json.bak`，沿用 `config.json.bak` 的做法 | 绑定层删除可恢复；后端会话数据删了不可恢复，确认文案写清 |
| D8 | reveal 接口的路径来源 | 服务端从 sid 或 key 解析出绝对路径，只允许三个根：实例配置目录、pi-sessions 目录、`~/.local/share/opencode`。不接受客户端传任意路径 | 本地服务也要防滥用：浏览器里任何页面都能打这个接口，不能变成打开任意路径的通用工具 |
| D9 | 桥接不在跑时 | 同一套代码，没有分支 | 不在跑时既没有监听也没有覆写者，admin 改完即生效；桥接下次启动读到的就是改过的文件 |

## 5. 需求清单（可验收）

| 编号 | 需求 |
|---|---|
| FR-1 | 飞书绑定表每行有「查看」「解除绑定」；没有绑定会话时「查看」禁用并说明原因 |
| FR-2 | 后端会话表每行有「查看」「删除」；被绑定的会话在标题列显示绑定数量徽章 |
| FR-3 | 「查看」在访达打开：pi 选中该会话的 jsonl 文件；opencode 打开 `~/.local/share/opencode` 目录 |
| FR-4 | 「解除绑定」从 state.json 移除该 key：先备份 `state.json.bak`，临时文件加重命名落盘 |
| FR-5 | 「删除」删后端数据：pi 删 jsonl 文件并删 `index.json` 条目；opencode 调 serve 删除接口 |
| FR-6 | 删除后端会话后，清掉指向它的绑定的 `sessionId` |
| FR-7 | `inflight` 里有该会话时拒绝删除，返回 400 与可读原因（提示先发 `/stop`） |
| FR-8 | 桥接侧：`state.json` 外部改动时单向同步删除；每次 flush 落盘前先同步一次 |
| FR-9 | 桥接侧：pi-sessions 目录外部改动时清掉索引内存缓存 |
| FR-10 | 删除有 confirm，后果写清（不可恢复、影响哪些绑定）；操作结果有可见反馈 |

## 6. 接口设计

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/instances/:name/reveal` | body `{ target: "session" \| "binding", sid?, key? }`。服务端解析路径并 spawn `open`，返回 `{ ok, path, kind }`（kind 为 file 或 dir） |
| DELETE | `/api/instances/:name/bindings/:key` | 解除绑定。备份加原子写 state.json。返回 `{ ok, bridgeRunning }` |
| DELETE | `/api/instances/:name/sessions/:sid` | 删除后端会话并清绑定。返回 `{ ok, clearedBindings }` |

三个接口沿用既有防护：Host 校验、`Content-Type: application/json`、`X-OCB-Admin: 1`。

**reveal 的路径解析规则**（服务端执行，D8）：

- `target=session`：pi 在 `pi-sessions` 目录按 `_<sid>.jsonl` 后缀找文件（与 `piModelOf()` 同一规则），找到则 reveal 该文件，找不到返回 400；opencode 先向 serve 确认会话存在（`GET /api/session/:sid`），不存在返回 400，存在则打开 `~/.local/share/opencode` 目录。
- `target=binding`：先从 state.json 取该 key 的 `sessionId`，没有则返回 400（页面按钮此时本就是禁用的）；有则按上一条解析。
- 解析出的路径必须落在三个允许根之内，否则 400。

**删除的前置检查**（两个 DELETE 接口共用）：读一次磁盘上的 state.json，`inflight` 里有目标会话的 sessionId 即返回 400，原因写「会话正在执行中，先在飞书里发 /stop 中止」。opencode 的删除额外要求 serve 可达，不可达返回 400 并说明此时只能解除绑定。

## 7. 桥接侧改动细节

### 7.1 Store 单向同步（src/store.js）

```
syncExternalDeletes():
  读磁盘上的 state.json；读失败或解析失败直接返回，不动内存
  对 this.data.chats 里的每个 key，磁盘上没有了 → 从内存删掉
  反向不传播：磁盘上没有而内存里有的（桥接自己刚建的绑定）保留
```

触发点两处：

1. `fs.watch(配置目录)`：目录下任何文件变动都触发一次同步。桥接自己 flush 写完也会触发，此时读盘比对发现绑定集合一致，空操作返回。监听器 `unref()`，测试进程能正常退出。
2. `flush()` 开头（`if (!this.dirty) return` 之后）：无条件先同步一次再落盘。这一处关闭覆写窗口：admin 的删除落在桥接待写的防抖窗口里时，flush 先把删除吸收进内存，再写出的文件就不含被删的绑定。

同步只比对 `chats` 的键集合，不比对条目内容；`queue`、`inflight`、`sessionSeq` 不参与同步。

### 7.2 pi 索引缓存失效（src/pi.js）

`PiBackend` 对 `sessionDir` 起 `fs.watch`（起监听前确保目录存在，与 `_save()` 同一做法；`_load()` 成功读到索引后调用一次幂等的 `_ensureWatch()`）。目录下任何变动把 `this._index` 置空，下一次 `_load()` 从磁盘读新索引。桥接自己 `_save()` 触发的事件同样只表现为一次重读，内容一致，无害。监听器 `unref()`。

opencode 后端不需要这一处：会话数据在 serve 里，桥接不缓存会话列表，删了就是删了。

## 8. 前端交互

- **飞书绑定表**加第 7 列「操作」：「查看」（绑定了会话才可点，否则禁用，悬停说明「这个绑定还没有会话」）、「解除绑定」（danger）。
- **后端会话表**加第 6 列「操作」：「查看」、「删除」（danger）。标题列在既有「机器人」徽章后追加绑定数量徽章（N 个绑定指向它时显示）。
- 空态与错误态的 `colspan` 随列数调整（绑定表 6 改 7，会话表 5 改 6）。
- 删除的 confirm 文案分后端：
  - pi：「删除后该会话的 jsonl 文件不可恢复。有 N 个飞书绑定指向它，这些绑定的会话关联会被清掉，下一次 @ 会在同一目录新建会话。确定删除？」
  - opencode：「删除后该会话的全部历史不可恢复（数据在 opencode 的本地数据库里，没有导出路径）。有 N 个飞书绑定指向它，这些绑定的会话关联会被清掉，下一次 @ 会在同一目录新建会话。确定删除？」
- 解除绑定的 confirm：「解除后，这个群或话题下一次 @ 机器人会新建一个会话。后端里已存在的会话不会被删除。确定解除？」
- 「查看」的结果反馈：pi 提示已在访达选中会话文件；opencode 提示已在访达打开数据库目录，并说明会话在 `opencode.db` 里、没有单会话文件。
- 操作结果写入会话页新增的状态行，成功与失败分别用 ok 与 err 样式，与配置页的 `cfg-msg` 保持一致。删除成功后刷新两张表。

## 9. 验收标准

| 测试 | 覆盖 |
|---|---|
| `scripts/test-admin.mjs`（纯函数） | reveal 路径解析：三个允许根之内、目录穿越拒绝、pi 按 sid 找文件、找不到文件返回错误；`syncExternalDeletes` 单向语义：磁盘删除传播到内存、内存新增保留、磁盘读失败不动内存 |
| `scripts/test-admin-api.mjs`（接口到落盘） | 解除绑定：`state.json.bak` 生成、chats 少一行、临时文件加重命名；inflight 占用返回 400；删除 opencode 会话（stub serve 的 fetch）：serve 收到 DELETE、指向它的绑定被清；删除 pi 会话：jsonl 文件没了、`index.json` 条目没了、绑定被清；reveal（stub spawn）路径与参数正确；serve 不可达时返回 400 |
| 桥接侧（`scripts/test-admin.mjs` 或新文件） | `syncExternalDeletes` 单元用例；一个集成用例：起 Store 后从外部改写 state.json 删掉一个 key，断言内存同步（监听是异步的，用例里轮询等待）；pi 索引缓存外部改动后失效 |

回归：既有全部 `test-*.mjs` 通过。

手动验收：起 admin，对 lil-p（pi）与 lil-o（opencode）各执行一次查看与一次删除；解除绑定后在飞书里 @ 一次，确认走的是新建会话。

## 10. 已知限制

1. **opencode 的会话没有单会话文件。** 「查看」只能打开数据库目录，内容要用数据库工具或 opencode 桌面版 App 看；「删除」走 serve 接口，删的是本地数据库里的行。
2. **删除不可恢复。** pi 的 jsonl 删了就没了；opencode 经 serve 删除没有导出路径。确认文案必须写清。备份只覆盖 state.json。
3. **admin 读-改-写 state.json 与桥接 flush 之间有毫秒级并发窗口。** 极端情况下桥接刚写的一个绑定被 admin 基于旧读入的写入覆盖，下一次 @ 会重建该绑定，无害。反方向（admin 的删除被桥接写回）由 FR-8 的 flush 前同步关闭。
4. **删除按钮只覆盖页面显示的最近 100 条会话。** 更早的会话在飞书里用 `/del`。
5. **僵尸 inflight 记录会误挡删除。** 进程崩溃遗留的记录正常在下次启动时被 `reconcileInflight()` 清掉；万一残留，手动编辑 state.json（有 `.bak`）。
6. **fs.watch 依赖本地文件系统事件。** 本机 APFS 可靠；万一丢事件，flush 前同步与桥接重启两条路兜底。

## 11. 实现清单

| 文件 | 变更 |
|---|---|
| `admin/public/index.html` | 两张表加操作列与绑定数量徽章；删除 confirm；新增操作结果状态行；空态与错误态 colspan 调整 |
| `admin/server.js` | reveal 与两个 DELETE 接口；`writeStateAtomic()`；删除前置检查（inflight、serve 可达性）；pi 索引条目删除 |
| `src/store.js` | `syncExternalDeletes()`；构造时起目录监听（unref）；`flush()` 开头同步一次 |
| `src/pi.js` | `_ensureWatch()` 与索引缓存失效 |
| `scripts/test-admin.mjs` | 纯函数用例扩充 |
| `scripts/test-admin-api.mjs` | 接口到落盘用例扩充 |
| `docs/design-notes.md` | 补一节：删除绑定为什么走「磁盘真相加单向同步」，config.json 的既有做法为什么套不上 state.json |
| `README.md` | 「会话与后端」页说明补充按钮与两个后端的差异 |

## 12. 后续

1. opencode 后端的会话内容查看：需要数据库查询能力（sqlite3 命令行或桌面版 App），不在本需求内。
2. 会话重命名、切换目录：飞书侧已有 `/rename` 与 `/cd`，admin 侧可后补。
3. 批量清理长期未更新的会话：需先定义「长期」与保留策略。
