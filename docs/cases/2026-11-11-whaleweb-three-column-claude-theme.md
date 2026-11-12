# Case：whaleweb 三栏 Claude 风 UI + 深/浅色主题 + 左栏「她看视频」+ 观看队列

## 现象 / 需求（用户原话）

> 后台改到右边侧屏，然后两种模式都加上深色模式和浅色模式，左边侧屏改成显示她看视频，
> 或者其他进程的后台，中间的区域可以窄一点，我现在有个插件是 claude 风格，整体风格参考那个，
> 也可以直接搬，同时准备加进 https://www.bilibili.com/.../BV1St4Y6jEkc 这个视频。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 / DSH 版本 | Windows，DSH `0.2.2-rc.1` |
| SurfCore 版本 | v0.8.9（whaleweb 子模块） |
| 安装方式 | git（分支 `本地`）；部署 `C:\dsh\whaleweb`（`WhalewebServer` 计划任务，SYSTEM） |
| 参考样式 | `dsh-claude-style` 插件（`~/.dsh/profiles/web/node_modules`），skin 与 `docs/STYLE.md` 的设计令牌 |

## 方案

1. **三栏布局**：`grid-template-columns: 280px 1fr 340px`。左=「她的活动」（待看队列+最近看的+进程状态），中=窄聊天（`max-width:680px` 居中），右=思考后台（从顶部搬到右侧）。`≤1000px` 收成单栏、侧栏隐藏。
2. **深/浅主题**：CSS 变量两套，`html[data-theme="dark"]` 覆盖；`localStorage.ww_theme` 持久化；头部 🌙/☀️ 切换。配色直接搬 `dsh-claude-style` 的 Claude card（accent `#d97757`、canvas `#ffffff`/`#191919`、sidebar `#fafafa`/`#1f1f1f`、ink `#161616`/`#fdfdfd`、border `#e9e9e9`/`rgba(255,255,255,.09)`）。
3. **左栏数据**：`/api/activity` 返回最近观看历史（读 `~/.dsh/surfcore/characters/*/bili/watch-history.jsonl`，取最新 mtime 那份）+ 主人额外给队列与进程状态（pet-api `/status`）。访客只拿历史，队列/状态在 API 层也不回。
4. **观看队列**：`~/.dsh/surfcore/pet/watch-queue.json`（`{items:[...]}`）。`POST /api/watch`（主人专用）收 BV 号 → 去重 → 尽量用 B站 公开接口补标题/UP/时长/封面。已预置 BV1St4Y6jEkc（「大肥鱼当虚拟主播？AgentL2D工作台…」）。

## 改动落点

| 文件 | 改动 |
| --- | --- |
| `whaleweb/server.mjs` | `STATE_DIR` 从 `hostFile` 推导；`readWatchQueue/writeWatchQueue/biliMeta/readWatchHistory`；`/api/activity`（主人带 queue/status，访客只 history）、`/api/watch`（主人专用、BV 校验、B站 元数据兜底） |
| `whaleweb/public/index.html` | 全量重写：Claude 深/浅 token、三栏 grid、左栏活动面板（队列/历史/进程/加视频表单）、右栏思考后台、主题切换、窄聊天 |
| `whaleweb/config.example.json` | 文档化 `stateDir` / `watchQueue` |

## 验证

- `node --check` server.mjs → 0；index.html 内联 JS `new Function` 语法通过。
- `/api/activity`：主人 `history=12, queue=1, status.ok=true`；访客 `history=12` 且**无** `queue`/`status` 键。
- `/api/watch`：访客 POST → `{"ok":false,"error":"只有主人能加视频"}`（403 语义，权限正确）。
- 队列预置：`watch-queue.json` 含 BV1St4Y6jEkc + 标题/UP/时长/封面。
- index.html 输出含「她的活动」「思考后台」、`data-theme` 主题钩子。
- 没验证：真实浏览器里三栏视觉、深/浅切换、加视频表单的交互（自动化点不了）。

## 遗留 / 后续

- **队列已接生物钟**（后续提交 `9b68741`）：`scheduler.js` 醒来提示词注入「0) 待看队列」、看完（进 `watch-history.jsonl`）自动标 `watched`；但**还没实机验证一次真实 B站 醒来会不会优先消费队列**。
- **两侧侧屏可拖拽调宽**（同一提交）：`resizer` 拖条 + `localStorage` 记忆，160~520px。
- 访客亲密度是全体访客共享一个值，没有按具体访客分人。
- 左栏「进程状态」目前只列桌宠/对话/模型/语音/专注，QQ 桥接与 B站 tick 还没接进来。
