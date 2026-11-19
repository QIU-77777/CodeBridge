# 默认模型设置

桥接不选模型，也不保存模型。每个实例在启动 agent harness 时，都由 harness 使用它自己本机配置里的默认模型。换模型只改 harness 的配置，不改实例配置，也不用改 `config.json`。

## 实例与模型来源

| 实例 | `backend.type` | 模型来源 |
|---|---|---|
| lil_p | `pi` | `~/.pi/agent/settings.json` 的 `defaultProvider` + `defaultModel` |
| lil_o | `opencode` | `~/.config/opencode/opencode.jsonc` 的 `model` |
| lil_k | `oar`（运行时 `kimi`） | `~/.kimi-code/config.toml` 的 `default_model` |

确认某个实例用哪个后端：

```bash
jq -r '.backend.type' ~/.config/opencode-feishu-bridge-<实例>/config.json
```

## pi

配置文件：`~/.pi/agent/settings.json`

```json
{
  "defaultProvider": "stepgo",
  "defaultModel": "deepseek-v4.1-flash-working"
}
```

可用模型清单在同目录的 `models.json`：`providers.<provider>.models[]`。清单里没有的模型，`defaultModel` 填了也找不到。

```bash
# 看模型清单
pi --list-models

# 单次覆盖（不改配置）
pi -p -nt --no-session -m <provider>/<model> "只回复 ok"

# 改完默认模型后重启实例
launchctl kickstart -k gui/$(id -u)/ai.qiguang.ocbridge.lil-p.app
```

桥接启动 pi 时不传 `-m`，用的就是 `defaultProvider` / `defaultModel`。常驻的 pi RPC 进程在改完配置后，新起的进程立即跟随；已经活着的进程最多等空闲回收（默认 10 分钟），重启实例则立即生效。

## opencode

配置文件：`~/.config/opencode/opencode.jsonc`

在根层加 `model` 键。格式是 `providerID/modelID`，也可以写成对象：

```jsonc
{
  "model": "stepcode/stepcode-gpt-6.1-sol-eastus2",
  "providers": {
    "stepcode": {
      "name": "stepcode",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://models-proxy.stepfun-inc.com/v1" },
      "models": {
        "stepcode-gpt-6.1-sol-eastus2": {
          "name": "stepcode-gpt-6.1-sol-eastus2",
          "limit": { "context": 1000000 },
          "package": "@opencode/ai/providers/openai-compatible/responses"
        }
      }
    }
  }
}
```

对象写法等价于：

```jsonc
"model": { "providerID": "stepcode", "model": "stepcode-gpt-6.1-sol-eastus2" }
```

按配置 schema，`model` 的含义是「没有会话或 agent 指定模型时使用的默认模型」。不写这个键时，opencode 用它自己的默认值。

```bash
# 列出全部可用模型（桌面版自带 CLI）
"/Users/you/Library/Application Support/ai.opencode.desktop/cli/<版本>/opencode-cli" models

# 或者问正在跑的 serve
curl -s -u opencode:<serve密码> http://127.0.0.1:19876/api/model/default

# 重启 serve 与实例，让新配置生效
launchctl kickstart -k gui/$(id -u)/ai.qiguang.ocbridge.lil-o.serve
launchctl kickstart -k gui/$(id -u)/ai.qiguang.ocbridge.lil-o.app
```

opencode serve 在启动时读配置，所以要重启 serve。已经建立的老会话由 serve 保存各自的模型，换默认模型后老会话可能沿用旧模型，发 `/new` 按新默认开新会话。

## kimi

配置文件：`~/.kimi-code/config.toml`

```toml
default_model = "deepseek/deepseek-flash"

[models."deepseek/deepseek-flash"]
provider = "deepseek"
model = "deepseek-flash"
max_context_size = 1048576
# ...
```

`default_model` 填下面 `[models."..."]` 里的别名。换一个模型时，先在该文件里补上对应的 `[models."..."]` 段，再改 `default_model`。

```bash
# 单次覆盖
kimi -m <alias> -p "只回复 ok"

# 重启 lil_k
launchctl kickstart -k gui/$(id -u)/ai.qiguang.ocbridge.lil-k.app
```

lil_k 走 OAR 的 kimi 运行时，实例配置的 `backend.oar.env` 为空，模型取自这份 config.toml。换成其他 OAR 运行时（claude、codex、qwen 等）时原则相同：读那个运行时自己的配置。

## 生效时机与验证

- 新会话、以及重启实例后新起的进程，使用新的默认模型。
- pi 的常驻进程空闲回收后跟随；opencode 与 OAR 的已有会话可能保留运行时里的旧模型，发 `/new` 开新会话。
- 验证方式：在飞书发一条消息，卡片顶部会显示本次实际使用的模型；也可以在 `logs/bridge.log` 里看到运行记录。

## 相关文档

- [pi 后端方案](pi-backend.md)
- [配置字段](../README.md#配置)
