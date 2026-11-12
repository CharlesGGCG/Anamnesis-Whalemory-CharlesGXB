# Case：whaleweb 鲸鱼主动发表情 + 开发者模式 + 身份识别→亲密度

## 现象 / 需求（用户原话）

> 搞定鲸鱼主动发表情的功能，加上一个开发者模式给主人/开发者使用，使用特殊邀请码进入，
> 她对主人和其他人的身份识别也会影响亲密度，开发者模式需要有她思考的后台。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows，DSH `0.2.2-rc.1` |
| SurfCore 版本 | v0.8.9（whaleweb 子模块） |
| 安装方式 | git（`C:\dsh\repos\surfcore`，分支 `本地`）；部署目录 `C:\dsh\whaleweb` |
| 其它 | dsh-nekowhale-stickers（表情目录/GIF 路由）；live 插件 `~/.dsh/plugins/surfcore` → junction 到仓库 |

## 方案（四条一块讲）

一条「身份 → 亲密度 → 语气 → 主动表情」的链路 + 一个开发者调试面板，挂在 whaleweb（脸）+ 桌宠对话后端 `pet-chat`（脑）：

1. **主动发表情**：`pet-chat` 提示词教她在回复末尾写 `[sticker:情绪或名字]`；后端 `extractSticker()` 拆出标记、正文清洗后存历史、标记作为 `stickerRef` 返回；whaleweb 按「名字精确 / 情绪随机抽」解析成 hash，前端在她气泡里正文 + GIF 一起渲染。
2. **开发者模式 + 特殊邀请码**：config 新增 `devInviteCode`；普通码→访客、开发者码→主人；一个 cookie 记住身份（`sha256(码)`），`/api/auth` 返回 `{identity, dev}`；`dev=true` 时前端显示 🧠 按钮。
3. **身份 → 亲密度**：主人恒 100；访客 20 起、每次互动 +1、封顶 60，持久化 `~/.dsh/surfcore/pet/intimacy.json`；亲密度注入 system prompt 改语气（`≥80` 亲昵 / `40-80` 友好 / `<40` 礼貌有分寸）；**历史按身份分文件**（`history-xxx.json` / `history-xxx-guest.json`），避免把主人私聊漏给访客。
4. **思考后台**：开发者身份下 `pet-chat` 额外返回 `debug`（身份/亲密度/模型/耗时/token/表情标记/记忆写入数 + 完整 system/user/raw/memory/purpose），前端 🧠 面板逐段展示。

## 改动落点

| 文件 | 改动 |
| --- | --- |
| `plugins/surfcore/lib/pet-chat.js` | `extractSticker`/`intimacyTone` 纯函数；`intimacyFile/readIntimacy/intimacyFor/bumpIntimacy`；`historyFile/readHistory/saveHistory/historyPayload` 加 identity；`buildChatSystemPrompt` 加 identity/intimacy/web（并修了 `${owner}` 对象拼进提示词的旧 bug）；`chat()` 加 `identity/web/debug` 入参、拆表情、bump 亲密度、返回 debug；`buildPetMemoryEvents` 加 `sender/isOwner`（访客别再记成主人） |
| `plugins/surfcore/lib/pet-api.js` | `/chat` 透传 `identity/web/debug`；`/history` 透传 `identity` |
| `whaleweb/server.mjs` | `devInviteCode`、`identityOf()`；`/api/invite`/`/api/auth`/`/api/chat`/`/api/history` 身份化；`resolveStickerRef()` 把 `stickerRef` 解析成 GIF；`/` 支持 `?invite=码` 双码自动放行 |
| `whaleweb/public/index.html` | 开发者 🧠 按钮 + 思考后台面板；`addHerBubble()` 渲染她的表情+正文；`showDebug()` 分段展示 |
| `whaleweb/config.example.json` | 文档化 `devInviteCode` |

## 验证

- `node --check` 全部通过；`import('./lib/pet-chat.js')` 冒烟通过。
- 纯函数：`extractSticker('哈哈 [sticker:开心]')` → `{text:'哈哈 ', ref:'开心'}`；`intimacyTone(100/50/20)` 三档正确。
- 端到端（真实模型）：
  - 开发者码 → `identity=owner`；`/api/chat` → `intimacy=100`、`debug` 完整返回（含 system/user/raw/memory/purpose/usage）。
  - 普通码 → `identity=guest`；`/api/chat` → `intimacy=20`、无 debug；`intimacy.json` 变 `guest:21`（+1 生效）。
  - 主动表情：模型原文 `"…太阳打西边出来了？\n\n[sticker:疑惑]"` → 回复带 `sticker:{hash,name:"邪门",emotion:"疑惑"}`，正文标记已剥离。
  - 历史隔离：owner 与 guest 各自独立历史。
- 没验证：真实浏览器里 🧠 面板的视觉交互（自动化点不了）。

## 遗留 / 后续

- 开发者邀请码目前是随机生成的 `rKgh8mNkAaZC`（写入部署 config），可随时换成用户自定。
- 访客亲密度是「全体访客共享一个值」，没有按具体访客分人（当前无用户体系，够用）。
- 主动表情的 GIF 没写进历史（重载后只回显文字，表情不重现）——可选后续。
