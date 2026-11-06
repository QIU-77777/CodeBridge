# tmux 运维层方案

## 需求上下文

用户在社群看到一套做法：用 tmux 一键拉起机器人——每次重启服务器后运行一次，n 个机器人全部拉起，全程自动；tmux 的好处是关掉终端窗口机器人不会停、随时查看日志、某个挂了直接重启那一个。

用户要求调研评估该方案是否适用于本桥接产品，背景是一次真实事故：Lil_O 自己把 server 切断了，之后需要第二个人或机器人帮它重启，过于麻烦。用户认可「补充 tmux 脚本」的方向，要求先把方案写进 PR 评审，再实施。

## 调研结论

tmux 方案可以用，且有两个真实增量；但它主打的三个好处里有两个本产品已经具备。**不用 tmux 替换现有 launchd 托管，以补充脚本方式落地。**

| 维度 | 现状（launchd 托管） | tmux 方案 |
|---|---|---|
| 关掉终端窗口不停 | 已满足：launchd 托管的进程不挂任何终端 | 无增量（detached session 同样不挂终端） |
| 进程挂了自动拉起 | 已满足：plist 的 KeepAlive 约 10 秒内重拉（ThrottleInterval 10） | 默认没有：session 内进程退出，session 即结束；要自愈必须包守护循环 |
| 随时查看日志 | 已满足：admin 日志页近实时跟随，或 `tail -f logs/*.log` | 体验相近：`tmux attach -t <实例名>` |
| 某个挂了重启那一个 | 已满足：admin 总览页按实例重启，或 `./scripts/up.sh` | 体验相近：`tmux kill-session` 后重拉那一个 |
| 一条命令全部拉起 | **不满足**：每个实例各跑一次 `install-agent.sh` 或 `up.sh` | **真实增量** |
| 跨平台 | 仅 macOS | **真实增量**：产品上 Linux 服务器时 launchd 不存在，tmux 是硬需求 |
| 单点故障 | 无：每个服务独立 | tmux server 自身是单点，且不扛机器重启（要再套 launchd 或 systemd 才能开机自启） |

那次切断事故的根因是「停掉之后不会自动回来」：KeepAlive 只管崩溃自愈，不管 `launchctl bootout`——`down.sh` 会摘掉服务，之后必须 `up.sh` 恢复。tmux 不修复这个根因（`tmux kill-server` 后同样要手动拉）。防复发靠两条：临时重启用 admin 的「重启」按钮或 `up.sh`，不要用 `down.sh`；确实全停后用 `up.sh` 一条命令恢复。

## 方案设计

### 新增两个脚本

```bash
./scripts/tmux-up.sh              # 拉起本机全部实例，每个实例一个命名 tmux session
./scripts/tmux-up.sh pi           # 只拉起指定实例
./scripts/tmux-down.sh            # 停止全部（kill 全部本产品的 session）
./scripts/tmux-down.sh pi         # 停掉指定实例那一个
tmux attach -t <实例名>           # 看某个实例的实时输出（tmux 原生命令，无需脚本）
tmux ls                           # 看所有 session 与存活状态
```

### 实例发现

扫描 `~/.config/opencode-feishu-bridge*` 目录，一个目录一个实例，实例名取目录后缀（缺省目录叫 `default`）。不用 plist：tmux 层面向「本机跑着的实例」，目录即真相；launchd 没装过的实例（nohup 起的）也要能拉起来。此命名规则与 admin 总览页对未装 plist 实例的展示一致。

### session 形态与守护循环

每个实例一个命名 session，session 名就是实例名。session 内不直接跑 `node src/index.js`，跑守护循环，补上 tmux 默认缺失的崩溃自愈（对应 launchd 的 KeepAlive）：

```bash
while true; do
  node src/index.js
  echo "[tmux] 进程退出，2 秒后重拉"
  sleep 2
done
```

### 单实例锁前置检查

桥接有单实例锁（配置目录下的 `bridge.lock`）。同一个配置目录已被别的进程拿着锁时（例如 launchd 路径已在跑），tmux 再起一个必然拿不到锁而退出，守护循环会每 2 秒重试、刷满日志。因此 `tmux-up.sh` 启动每个实例前必须检查：该配置目录的锁是否被进程持有且命令行匹配 `src/index.js`；是则跳过该实例并打印提示，不进入守护循环。

### opencode serve 的处理

opencode 后端的实例需要本机 serve。`tmux-up.sh` 对这类实例先探配置里的 serve 地址：没在听就顺带起一个 `<实例名>-serve` 的 session（用 `scripts/which-opencode.mjs` 选二进制，密码与端口取自该实例配置）；已在听则跳过。pi 后端不涉及。

### 与现有机制的关系

- **与 launchd 并列，由用户自选。** `install-agent.sh` 路径不变；tmux 路径不创建、不修改任何 plist，两条路互不写入。
- **与 admin 正交。** admin 管配置与状态；admin 的起停按钮走 `up.sh` / `down.sh`（launchd 路径），管不了 tmux session。tmux 托管的实例在 admin 总览页显示为「未安装常驻服务」的只读行，起停用 tmux 脚本。不在本方案内把 tmux 接进 admin。
- **不改造 `up.sh` / `down.sh` / `install-agent.sh` 的既有语义。**

### 边界（明确不做）

- 不用 tmux 替换 launchd：开机自启（RunAtLoad）与崩溃自愈（KeepAlive）不能丢。
- 不做 tmux server 的开机自启：本机用户登录后 launchd 已把桥接拉起来，tmux 是可选路径；上 Linux 时再用 systemd 托管 tmux server，列为后续。
- 不把 tmux 管理接进 admin 界面。
- 不为 tmux 路径新增配置文件：实例清单来自配置目录扫描，session 名来自目录后缀。

## 验收标准

1. `./scripts/tmux-up.sh` 一条命令把本机全部实例拉起来；`tmux ls` 中每个实例一个命名 session。
2. 关掉终端窗口后 session 不受影响；kill 掉某个 session 里的桥接进程，2 秒内自动重拉。
3. `tmux attach -t <实例名>` 能看到实时输出；`tmux kill-session -t <实例名>` 停掉单个。
4. 锁前置检查生效：对已在 launchd 下运行的实例再跑 `tmux-up.sh`，跳过并提示，不产生守护循环空转与日志刷屏。
5. 两条路径互不干扰：tmux 路径不创建 plist；launchd 路径不受 tmux 操作影响。
6. README 补「tmux 运维」一节，说明两条路径各自适用场景与命令。

## 风险

- tmux server 是单点且不扛机器重启：本机场景可接受（launchd 仍是主路径）；上 Linux 时用 systemd 托管 tmux server 兜底。
- 守护循环与 launchd KeepAlive 可能同时想起一个实例：单实例锁保证同一时间只有一个进程真正运行，另一条路径在锁检查处被挡掉（tmux 侧靠前置检查，launchd 侧进程拿不到锁自然退出）；不会双跑，但用户不应把同一个实例同时挂两条路。
