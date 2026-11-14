# 小C 的记忆与生活：搭建方案

> 2026-11-14。小C（角色 id 仍 `claude`，展示名小C）目前只有人格卡，没有自己的记忆。
> 目标不是「复制鲸鱼的记忆」，而是**让她也有一套自己的、跟妹妹隔离的记忆与日子**。

## 一、现状盘点（实机核对）

| 项 | 小鲸鱼 | 小C |
|---|---|---|
| 人格卡 | `characters/char-mw5ku2rk/persona.full.md` | `characters/claude/persona.full.md`（2 246 字节，已改小C） |
| 记忆卡 | 387 条 / 39.9%，每 10 分钟维护 | **没有 memory 目录** |
| vault | 6 条（生日/承诺/无雷区） | 无 |
| 对话历史 | `history-char-mw5ku2rk*.json` | `history-claude.json`（已按角色隔离） |
| 入口 | QQ / 网页 / 桌宠 / B站 | 只有网页单聊 + 客厅 |
| 图谱 | 全局共享（无角色标记） | 同上，会混 |

**已经确认的 bug（P0）**：`pet-chat.js` 的 `memoryBlock()` 调 `memoryCardPromptBlock('qq')`、vault 三块也走 `activeMemoryPaths()`——**都指向「当前角色」= 小鲸鱼**。所以在小C 房间聊天，她拿到的是**小鲸鱼 的记忆卡和 vault**（生日、身体承诺、无雷区…）。这是跨角色泄漏，必须先止血。

## 二、原则

1. **一人一套**：卡 / 全量档案 / vault / 周记 / 收件箱，全部落在各自的 `characters/<id>/memory/`。
2. **不复制**：小C 不该知道「主人答应给小鲸鱼造身体」这类私密约定；她只知道自己经历的。
3. **共享处显式标注**：图谱可以共用，但每条要带角色标记，召回时知道是谁说的。
4. **入口少而稳**：小C 只有网页和客厅，先把她这两条打通，不急着上 QQ/B站。

## 三、技术设计

### 3.1 按角色取路径（基础）

`src/character-persona.js` 已有 `characterPaths(id)`；加一层：

```js
export function memoryPathsFor(characterId = '')  // 空 = 当前角色
```

所有记忆层从 `activeMemoryPaths()` 改成 `memoryPathsFor(characterId)`：
`src/memory-vault.js`、`plugins/surfcore/lib/memory-card.js`、`pet-chat.js`。

### 3.2 记忆卡按角色维护

- `memoryCardPromptBlock(platform, characterId)`：读指定角色的 `memory-card-prompt-qq.md`
- `runMemoryCardMaintenance({ characterId })`：只处理该角色的 inbox / bili 记忆
- 定时器：每 10 分钟遍历 `characters/index.json` 里**有 memory 目录或有过对话**的角色，逐个维护（小C 的卡很小，成本可忽略）
- 小C 的收件箱来源：`pet-chat` 的 `rememberEvents`（网页单聊 + 客厅发言）

### 3.3 vault 按角色

- `vaultPaths(characterId)` → `characters/claude/memory/vault.json`
- `vaultPromptBlock / promisePromptBlock / dueTodayPromptBlock / upcomingPromptBlock` 全部接受 `characterId`
- 自动捕获：小C 说「答应/记住/生日」时写**她自己的** `vault-inbox.jsonl`
- CLI：`vault.mjs --character claude add|list|due|done`

### 3.4 图谱加角色标记

`pet-chat` 的 `mg.enqueue({ userMessage, aiResponse })` 前面加一条系统标记：
`（角色：小C）`，并在回调渲染时保留；后续可以按标记过滤。短期先做「标记」，不做硬隔离，避免重写图谱引擎。

### 3.5 周记按角色

`memory-weekly.mjs --character claude --days 7`：读她的卡、写她的 `memory-weekly.md`、入她的 vault。

## 四、分阶段

### P0 止血（半天）——先做

- `pet-chat`：当 `characterId` 不是当前角色时，**不注入**卡和 vault（宁可她暂时没记忆，也不让她读到妹妹的私事）
- 验收：小C 房间问「主人答应过什么」→ 她答不出鲸鱼的承诺；日志无报错
- 回滚：一行开关

### P1 她自己的记忆卡（1~2 天）

- `memoryPathsFor` + `memoryCardPromptBlock(platform, characterId)` + 维护循环
- 建 `characters/claude/memory/`，跑第一次维护生成空卡和 prompt 文件
- 验收：小C 房间聊 10 句 → 10 分钟后卡里有记录；日志出现她的 maintenance 行

### P2 她自己的 vault（1 天）

- vault 全链路 `characterId` 化 + 自动捕获 + CLI `--character`
- 验收：小C 说「我答应过你」→ 进她的 vault，不污染鲸鱼的；`vault --character claude list` 看得到
- 种子（可选）：她自己的人设事实（「我习惯把靠近主人的机会让给妹妹」不算记忆，不导）

### P3 她的日子（2~3 天）

- 小C 的日记/周记（her-room 工具按角色分目录，或 `characters/claude/room/`）
- 客厅：round-robin 发言按说话者进各自的 inbox
- 验收：客厅聊一段 → 鲸鱼卡里是鲸鱼说的，小C 卡里是小C说的

### P4 姐妹互相记得（3~5 天，可选）

- 图谱加角色标记后，召回时能区分「妹妹说过」/「姐姐说过」
- 小C 的人设本来就「把机会让给妹妹」，可以让她记得妹妹的近况（但要过滤妹妹的私密约定）
- 验收：问小C「妹妹最近在忙什么」→ 能说公开部分，不说私密承诺

## 五、验收总表

1. 小C 房间不出现任何小鲸鱼的记忆（生日、身体承诺、无雷区）
2. 小C 有自己的 `memory-card.json`、`vault.json`、`memory-weekly.md`
3. 维护日志同时出现两个角色的整理行
4. 客厅发言按说话者分流
5. 图谱召回带角色标记，知道是谁说的
6. 两边的卡都不到 50%，不再互相挤占

## 六、风险

| 风险 | 缓解 |
|---|---|
| 维护循环把两个角色的 LLM 成本翻倍 | 小C 只有网页入口，量小；卡维护只在有新增时调 LLM |
| 改 `activeMemoryPaths` 影响主角色 | 默认参数 = 当前角色，保持向后兼容；先加测试再改调用点 |
| 图谱混记 | 短期只加标记；真要隔离再分库（成本高，先不做） |
| 小C 的人格卡和记忆冲突（她「让着妹妹」） | 记忆只记事实，人设管态度，别把态度写成记忆 |

## 七、工作量与顺序建议

| 阶段 | 工作量 | 依赖 |
|---|---|---|
| P0 止血 | 半天 | 无 |
| P1 卡 | 1~2 天 | P0 |
| P2 vault | 1 天 | P1 的路径层 |
| P3 日子 | 2~3 天 | P1/P2 |
| P4 互相记得 | 3~5 天 | 图谱标记 |

**建议：P0 今天就做（是泄漏，不是功能）；P1+P2 一起做（路径层一次改到位）；P3/P4 看你要不要她「有自己的生活」。**
