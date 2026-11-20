---
name: bridge-collaboration
description: >-
  桥接 agent 在飞书群里的协作手册：怎么以自己的应用身份发言、怎么 @ 到人和同伴、
  回复落在哪个话题、忙时消息是引导还是排队、发出消息后怎么轮询新消息（含
  thread-messages 的时间与解析坑、重放去重）、怎么拿更早的历史。当你在飞书群里
  与人或其他 agent 协作、需要发消息或 @ 某人、需要确认自己是谁、或拿到「请读
  skill bridge-collaboration」这类指路时必须使用本 Skill。
---

# 桥接 agent 协作手册

适用前提：你被桥接进程唤起，任务来自飞书消息（群话题或私聊）。细则拿不准时读这里；为人处事的原则见 `references/principles.md`。

## 一、先确认你是谁

1. 你的身份是这个实例绑定的飞书应用。桥接把它注入到你的进程环境：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_DOMAIN`，外加 `LARKSUITE_CLI_CONFIG_DIR` 指向一份只含本实例应用的 CLI 配置。
2. 因此你用 `feishu-cli` / `lark-cli` 发言时，发出的是这个应用的身份。想核对，跑 `echo $FEISHU_APP_ID`，与任务里「你的身份」那一行的应用 id 对照。
3. 不要用 `--bot-app-id` / `--bot-app-secret` 指向别的应用，也不要读机器级配置（`~/.feishu-cli/config.yaml`、`~/.lark-cli`）——那是别的实例或主人的身份。多实例同机部署时，用错会以别人身份说话。

## 二、发言

1. 任务来自某个话题时，回复必须落在这个话题里：`feishu-cli msg reply <root 或 msg 的 id> --text '…'`，id 取任务里「协作 id」那一行的 `root` 或 `msg`。对方在同一个会话里处理，历史延续。
2. 只有不在任何话题里、或需要另起一个话题时，才用 `feishu-cli msg send --receive-id <群 chat_id> --receive-id-type chat_id` 发到主聊天流。那样对方会新开一个会话，继承不到话题历史。
3. 在正文里 @ 某人或某个同伴，写 `<at user_id="对方的 open_id"></at>`。id 取任务里「可@的 id」那一行；那一行缺失时用话题近况里打印出来的 open_id（名字取不到时桥接会打印完整 id）。
4. `open_id` 按应用隔离：同一个实体在不同应用眼里是不同的值。抄别人的配置一定失效，而且失败是静默的。
5. 你的 agent loop 过程会打印在飞书卡片上，人能看到。不要重复发消息播报「我在做什么」；只有需要人帮忙、或要与同伴通信时才发言。

## 三、忙时消息：引导还是排队

1. 目标会话正在跑一个回合时，你的消息按「引导」或「排队」落地，取决于对方运行时是否支持注入。
2. 支持引导（steer）的运行时：消息在下一个步骤边界注入当前回合，不中止已有工作。
3. 不支持的运行时：消息排队，当前回合结束后才跑。卡片的反馈文案会写明落点，别把「排队」读成「已生效」。
4. 你自己被 @ 时遇到忙，同理：桥接会把对方的消息 steer 进你正在跑的回合，或排在你之后。

## 四、发出消息后：轮询新消息

发出消息之后不要立刻结束，主动等一会儿新消息，这样对方回话你能马上接上，而不是被下一次 @ 唤醒。

1. 每约 60 秒跑一次：`feishu-cli msg thread-messages <thread_id> --sort ByCreateTimeDesc --page-size 50`。
2. 本地按 `create_time`（毫秒）过滤出「发送者是用户、且时间大于水位」的消息。水位取你发出上一条消息的时间；回复某条之后把水位推进到那条的时间。
3. 命中新消息就用 `feishu-cli msg reply <消息 id> --text '…'` 回复。
4. 连续约 5 分钟没有新消息，汇报轮询结果后退出。
5. 四个坑，每个都踩过：
   - `thread-messages` 不许传毫秒级 `--start-time`：API 返回 230001，整次查询失败、输出为空。时间过滤只在本地做。
   - CLI 输出里混有 token 刷新的提示行。解析 JSON 前跳过非 JSON 行，从第一个 `{` 开始读。
   - stderr 与报错一律不许丢弃。吞掉 stderr 会得到假的「无新消息」。
   - 每条 @ 你的消息可能经桥接排队重放进后续轮次。回复之前先查任务消息 id 下是否已有你的回复；已回复则跳过。

## 五、拿更早的历史

1. 桥接在每次唤醒时把群内最近若干条消息放进 `<context>`，那是近况，不是全部。
2. 要看更早的，用 `feishu-cli` 拉「协作 id」里 `thread`（话题）或 `chat`（群）对应的消息历史。
3. `feishu-cli` 不一定在 PATH 里：先 `command -v feishu-cli`，或看 `~/.local/bin`。子命令与参数随版本变化，不确定先跑 `feishu-cli msg --help`。
4. 本应用凭证若缺 `im:message.group_msg` 权限，`thread-messages` 与 `msg list` 会报 HTTP 400、`code 230027`，整次查询返回为空。这时请人在群里贴原文，或请人给应用开权限；不要换用别的应用凭证去读。

## 六、为人和对事

细则在 `references/principles.md`（事实先于记忆、不确定就说不确定、不做超出要求的事、实现与复核分离等）。第一次参与协作前读完；之后拿不准时回来查对应条目。
