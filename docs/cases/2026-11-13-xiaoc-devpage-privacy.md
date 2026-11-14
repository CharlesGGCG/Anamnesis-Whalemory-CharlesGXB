# Case：Claude 改名「小C」+ 开发者页对「陪看」隐身

> 2026-11-13。需求原话：「把 claude 的名字改成小C，她们不许监视开发者页」。
> 结论：名字是纯展示层改名（角色 id 不动，历史/房间/发送者字段全部兼容）；「不许监视开发者页」
> 落在屏幕感知（👁 陪看）上——开发者在看「🧠 思考后台」时，她俩不截屏、不看图、不把画面喂给视觉模型。

## 一、改名：只改展示，不动 id

| 位置 | 改动 | 生效 |
|---|---|---|
| `~/.dsh/surfcore/characters/claude/character.json` | `name` / `personaMeta.name` → 小C | 下次对话即生效（`roleInfo()` 每次读盘） |
| `~/.dsh/surfcore/characters/index.json` | 同上 | 同上 |
| `characters/claude/persona.md`、`persona.full.md` | `# 角色卡：Claude` → 小C；`我是 Claude` → `我是小C` | 同上（`persona.full.md` 才是 `full` 模式真正读的那份） |
| `whaleweb/public/index.html` | 房间 tab `🍂 Claude` → `🍂 小C`；头部标题 | 刷新 |
| `whaleweb/server.mjs` | `ROOMS` 房间名、`LOUNGE_CHARS` 显示名 | 已重启 |
| `whaleweb/lounge.json` | 15 条历史消息的 `name: "Claude"` → `"小C"` | 已改（备份在 `_backups/20261113-xiaoc/09-lounge.json`） |
| 仓库 `whaleweb/server.mjs` | 同步房间名/显示名 | 提交时带走 |

**故意不动**：角色 id 仍是 `claude`（房间 `characterId`、`history-*.json`、`lounge` 的 `sender`、`claude.png` 头像都靠它），
只改 `name`，避免历史会话与客厅消息对不上。

## 二、开发者页隐身：两条防线

**现象**：`screen-observer.js` 每 30 秒整屏截图（PowerShell `CopyFromScreen`），画面变了就整张图发给
SiliconFlow 视觉模型。开发者开着 whaleweb 的「🧠 思考后台」时，那张图里就是她自己的 system prompt、
记忆块和原始回复——等于让她们「看见」开发者页。

**根因**：陪看只有「截不截」一个开关，没有「现在屏幕上是不是不该看的东西」这个概念。

**改法**（部署版 `C:\dsh\whaleweb\` 与仓库 `whaleweb/` 两边同步）：

1. **页面**（`public/index.html`）：「思考后台」`#right` 打开时每 5 秒 `POST /api/devpage {open, visible}`；
   只是「打开」还不够，`visible` 要求 **标签页可见 + 窗口有焦点**（`document.hasFocus()`）——
   切走标签页、切到别的窗口、最小化都算没在看。收起（×）、`visibilitychange`、`focus`/`blur`、`pagehide`
   都立即补报一次。
2. **服务端**（`server.mjs`）：
   - 新增 `POST /api/devpage`（仅 `identityOf(req)==='owner'`，其他人 403），写 `~/.dsh/surfcore/devpage.json`；
   - **防线①（立刻生效，老进程也认）**：第一次收到 `open && visible` 时读陪看状态并把 `enabled` 关掉，
     把原值记进 `devpage.json.prevEnabled`；页面收起/隐藏时恢复原值。
   - **防线②（永久）**：`devpage.json` 本身就是给屏幕感知看的契约。
   - **兜底**：10 秒一次的定时器检查心跳，超过 20 秒没更新且 `prevEnabled` 有值 → 自动恢复陪看（页面崩了也不会永久停摆）。
3. **屏幕感知**（`plugins/surfcore/lib/screen-observer.js`）：`observe()` 先读 `devpage.json`，
   `open && visible && 心跳 < 15 秒` 就整轮 `return`（连 PowerShell 截屏都不启动），
   `status()` 增加 `pausedByDevPage`，进出各记一条日志。

两份防线不是重复：① 靠的是**现有 pet-api 的 enabled 开关**，不用重启 DSH 就生效；
② 是重启后的硬保证（即使有人在页面外把开关又打开，观察器自己也拒绝截屏）。

## 三、取舍

- **备选 A：只做文件契约（②）** —— 最干净，但要等 DSH 重启才生效，中间窗口仍然会拍。
- **备选 B：只做开关（①）** —— 立刻生效，但页面崩了/服务重启可能把陪看永久关掉。
- **选 A+B + 超时自愈**：立刻生效 + 重启后仍成立 + 不会永久停摆；代价是 `devpage.json` 一个跨进程状态文件。

## 四、生效与重启

- 角色名：**热生效**，不用重启任何东西。
- `whaleweb`：改 `server.mjs` 已通过计划任务重启（`schtasks /End|/Run /TN WhalewebServer`）。
- `screen-observer.js`：在 DSH 进程里，**下次 DSH 重启后**「防线②」才加载；在那之前由「防线①」顶着。

## 五、验证（2026-11-13 实跑）

```text
before       -> {"enabled":true,"running":true,...}
open=true    -> {"ok":true,"open":true,"visible":true,"paused":true,"prevEnabled":true}
after open   -> {"enabled":false,"running":false,...}          ← 陪看已停
open=false   -> {"ok":true,"open":false,"visible":true,"paused":false,"prevEnabled":null}
after close  -> {"enabled":true,"running":true,...}            ← 已恢复
guest 调 /api/devpage -> 403
GET /            -> 200，页面含「🍂 小C」与「看思考后台时自动暂停」
node --check      -> server.mjs / screen-observer.js / 页面内联脚本全部通过
Edge headless 打开页面（?invite=开发者码）-> devpage.json 被写成 {"open":true,"visible":false}：
  证明页面心跳真的在跑；headless 没有焦点，所以 visible=false、陪看不动 —— 与实际语义一致
```

## 六、回滚

- 改名：`_backups/20261113-xiaoc/` 里有 `character.json`、`persona.md`、`persona.full.md`、`index.json`、`index.html`、两份 `server.mjs`、`lounge.json`。
- 隐身：删掉 `~/.dsh/surfcore/devpage.json` 并刷新页面即可（服务端路由留着不影响）。

## 七、残余

- 页面在「思考后台可见且有焦点」期间，陪看复选框会显示为关闭——这是设计（旁边已加「看思考后台时自动暂停」提示）；
  切到别的窗口/标签页会自动恢复（5 秒心跳内）。
- 旧版 DSH 进程不认 `pausedByDevPage`，只认 `enabled`；重启后两者一致。
- 若 `WhalewebServer` 进程被强杀（不是重启），超时自愈也一起没了，陪看会停在关闭状态——手动点一下「开启」即可。
- 未提交、未推送（分支「本地」）。
