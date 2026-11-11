# Case：whaleweb 发表情但鲸鱼「读不到」（只本地回显、未投递给模型）

## 现象

- 用户原话：`修一下网站她无法读取表情包的问题`
- 复现：whaleweb（`https://whale.whalemory.com`）点开 🐋 表情选择器、点一张表情 → 图片只在聊天里本地显示成一个「我」的气泡，**鲸鱼没有任何反应**。
- 影响面：只影响「用户发表情」这条交互；不丢数据、不涉及密钥，回滚只是还原两个文件。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows，DSH `0.2.2-rc.1` |
| SurfCore 版本 | v0.8.9（whaleweb 子模块） |
| 安装方式 | git（`C:\dsh\repos\surfcore`，分支 `本地`）；部署目录 `C:\dsh\whaleweb`（`WhalewebServer` 计划任务跑 SYSTEM） |
| 其它相关版本 | dsh-nekowhale-stickers（表情目录 / GIF 路由） |

## 根因

- 代码位置：`whaleweb/public/index.html` 的 `sendSticker()`。
- 问题链条：`sendSticker()` 只做了「本地渲染一张 `<img>` 气泡」，**从不调用 `/api/chat`**，所以这张表情永远到不了鲸鱼（桌宠对话后端）。桌宠后端 `plugins/surfcore/lib/pet-chat.js` 的 `chat()` 只收 `text`，本身没有图片通道——表情必须被转成文字描述投递。
- 为什么之前没发现：表情选择器刚在 `81dacda` 接入，属于「先做了 UI 回显、还没接投递」的半成品；后端 / API / GIF 路由全链路其实是好的（抽测 33 张 GIF 全 200），只在「点击后投递」这一步断掉了。

## 完整逻辑

- **链路**：浏览器 `index.html` → `sendSticker()` →（原来：到此为止）→ 现在 `deliver(stickerText(s))` → whaleweb `/api/chat` → `pet-api /chat` → `pet-chat.chat()` → DSH `llm` 出文字回复 → 回到气泡。表情元数据由 whaleweb `server.mjs` 从 `dsh-nekowhale-stickers/meta/nekowhale.json` 读入，映射后经 `/api/stickers` 给前端。
- **机制**：前端「发文字」走 `addBubble('me', text) + deliver(text)` 两步；「发表情」漏掉了第二步。发文字时 `deliver` 会把文本经 `/api/chat` 送进模型并写进历史，发图片则没有任何东西进模型。
- **爆炸半径**：1 个进程（whaleweb 前端 JS） × 1 个读者（本机 `server.mjs` 已把 index.html 读进内存，改完要重启） × 报错=1 → 低。不碰用户数据 / 密钥 / 花钱（只是把一条描述文本当聊天消息送）。
- **取舍**：A) 前端把表情转成文字描述投递（选这个，最小改动、零新契约）；B) 给 `pet-chat`/`pet-api` 加图片消息通道（改动大、涉及桌宠与 QQ/B站 共享链路，收益不成比例）。
- **生效与重启**：`index.html` 和 `server.mjs` 都在 whaleweb 启动时读进内存，改完要重启 `WhalewebServer`；桌宠/DSH 不用动。

## 修法

- `server.mjs`：`/api/stickers` 的映射补 `name`（去掉编号前缀）与 `desc`（画面描述），让前端能拼出「她看得懂的描述」。
- `index.html`：新增 `stickerText(s)`，`sendSticker()` 渲染完图片后 `deliver(stickerText(s))`，把 `[表情：名字（情绪）] + 描述` 投给鲸鱼。
- 回滚：`git checkout -- whaleweb/public/index.html whaleweb/server.mjs`，部署目录同样还原后重启 `WhalewebServer`。

## 验证

- `node --check` 两个 `server.mjs` → exit 0。
- 重启后 `/api/stickers` → count=322，首条含 `name=猫猫搓手`、`desc=…`。
- 端到端：`/api/chat` 发 `[表情：猫猫搓手（兴奋）] 大肥鱼眯眼微笑…` → 200，回复「这表情是想干点啥坏事了？手搓得挺起劲啊，说吧，我听着。」（3169ms）。
- 公网隧道 `https://whale.whalemory.com`：`/api/stickers` 322、`/s/<hash>.gif` 200。
- 没验证：真实浏览器里点表情后的 UI 动效（自动化点不了）；表情图是否在历史重载后仍显示（当前是文字描述进历史，图片不进）。

## 遗留 / 后续

- 待办「鲸鱼主动发表情」仍未做（这次只修「读」，没加「发」）。
- 可选：把用户发的表情也以图片形式写进历史（目前只写文字描述）。
