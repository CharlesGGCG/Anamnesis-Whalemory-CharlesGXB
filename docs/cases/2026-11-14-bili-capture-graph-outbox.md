# Case：B站 观看 / 评论 进记忆图谱（出站队列）

> 2026-11-14。待办 B-5：把她看的视频、发的评论也喂进记忆图谱（此前只有 QQ / 桌宠在捕获）。

## 一、现象与根因

- **现象**：`memory-graph` 里只有 QQ 对话和桌宠/网页对话；她在 B站 看了什么、评论里说了什么，记忆图谱完全不知道。
- **根因有两层**：
  1. 捕获入口只有两处：`src/bridge.js`（QQ 收到回复后）和 `plugins/surfcore/lib/pet-chat.js`（桌宠/网页每轮）。B站 的 `debrief` / `bili-watch` / `comment` 都是**独立短进程**，根本没被接进来。
  2. 就算接进来也接不住：引擎的 `enqueue()` **只写内存**，`flush()` 才真正抽取入图（`src/memory-graph-engine/engine.js:91-123`）。短进程 enqueue 完就退出 = 丢；await flush 又要多等 2~5 秒（还要跑一次 LLM）——看视频/发评论都会变慢。

## 二、改法：文件出站队列

**工具进程（短）**：只往 `~/.dsh/surfcore/graph-outbox.jsonl` 追加一行（同步、毫秒级）。

**插件进程（长）**：每分钟 `take` 一次（原子 rename 成 `.processing`）→ 逐条转成对话 → `enqueue` → `flush` → 成功后删 `.processing`；失败把队列并回去，下次重试。

| 文件 | 作用 |
|---|---|
| `plugins/surfcore/tools/lib/graph-outbox.mjs`（新） | 队列读写 + 事件→对话映射 `turnForGraphEvent()` |
| `plugins/surfcore/lib/graph-outbox.js`（新） | 插件侧 drain：每分钟一次、串行、成功才删、失败回滚 |
| `plugins/surfcore/tools/commands/debrief.mjs` | 记观看历史后 `pushGraphEvent({kind:'bili-watch'})` |
| `plugins/surfcore/tools/commands/bili-watch.mjs` | 直接抽帧看也记一条 |
| `plugins/surfcore/tools/commands/comment.mjs` | 评论发成功后 `pushGraphEvent({kind:'bili-comment', text})` |
| `plugins/surfcore/lib/index.js` | 启动 drain（`createGraphOutboxDrain().start()`） |
| `scripts/test-graph-outbox.mjs`（新） | 9 组断言：push/take/commit/rollback/映射/drain/失败回滚 |

**一个容易踩错的点（已踩）**：引擎把 `userMessage` 当成「主人说的话」。如果写成
`userMessage: '她看了《X》'`，抽取结果会变成「**主人**看了《X》」。所以事件必须放在
`aiResponse`（她的那一侧），`userMessage` 只放一句系统标记。实测对比：

- 旧写法 → 「主人观看了B站视频《深海纪录片》…」
- 现写法 → 「**小鲸鱼**在B站观看了视频《深海纪录片》…还在评论区留言称赞片子拍得好」

## 三、完整逻辑

1. **链路**：`debrief/bili-watch/comment`（node 子进程）→ `pushGraphEvent()` → `graph-outbox.jsonl` →
   （DSH 插件进程，60s）`drainOnce()` → `MemoryEngine.enqueue/flush` → `~/.dsh/surfcore/memory-graph/{nodes,edges}.jsonl`
   → 下次 `graphRecallBlock()` 召回进她的 prompt。
2. **机制**：rename 原子性保证「读到的一定是完整行」；`commit` 只在 flush 成功后执行；
   引擎起不来时整批回滚，不丢；flush 失败时提交（避免重复入图）并记日志。
3. **爆炸半径**：三个 CLI 各多一次同步 `appendFileSync`（<1ms），失败静默（`pushGraphEvent` 不抛）；
   只写 `~/.dsh/surfcore/`，不碰 B站 接口；每次捕获消耗一次 SiliconFlow 抽取 + 向量（按条计费）。
4. **取舍**：对比过「CLI 里直接 await flush」（简单但每条多 2~5 秒、失败即丢）与「出站队列」（多一个文件与一个定时器）；
   选后者，因为看视频/发评论是高频且不能变慢的路径。
5. **生效**：`tools/*.mjs` 随下次命令生效；**插件侧 drain 要 DSH 重启**才加载（与 A-2 同一次重启）。
6. **验证**：
   - `node scripts/test-graph-outbox.mjs` → 9 组断言通过
   - 真引擎 + SiliconFlow 端到端：2 条事件 → `ingested:2`，`recall('深海纪录片')` 返回上面那条正确归属的记忆
   - 真实 `graph-outbox.jsonl` 保持不存在（测试全部走临时目录）
7. **回滚**：删掉 `plugins/surfcore/lib/index.js` 里两行 start 即停用；已入图的记忆按需在 `memory-graph/` 里清理。

## 四、残余

- 只接了三类事件（看视频/抽帧看/发评论）；收藏、动态、私信没有接。
- 插件侧 drain 与「开发者页隐身」硬守卫都要 **DSH 重启**才生效。
- `npm run test:audit` 当前 137/153，失败的 16 个是既有环境问题（时区/状态文件），
  已用 `aea55d9` 的干净 worktree 交叉验证过同名脚本同样失败，与本次改动无关。
