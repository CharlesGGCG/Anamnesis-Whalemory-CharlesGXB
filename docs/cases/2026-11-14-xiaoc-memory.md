# Case：小C 的记忆与生活（P0~P4）

> 2026-11-14。目标：让小C（角色 id `claude`）有自己的记忆，且和小鲸鱼**完全隔离**。

## 一、P0 止血：跨角色泄漏

**问题**：`pet-chat.js` 注入记忆卡 / vault 时一律走 `activeMemoryPaths()`（当前角色 = 小鲸鱼）。
在小C 房间聊天，她拿到的是**妹妹的记忆卡和 vault**（生日、身体承诺、无雷区）。

**改法**：所有记忆层加 `characterId` 参数，默认空 = 当前角色（向后兼容）。

- `src/character-persona.js`：新增 `memoryPathsFor(characterId)`（复用已有 `characterPaths`）
- `src/memory-vault.js`：`vaultPaths(characterId)`；`load/save/add/list/done/remove/…` 全部接受 `characterId`；
  `vaultPromptBlock / promisePromptBlock / dueTodayPromptBlock / upcomingPromptBlock / pushVaultCandidate` 也接受
- `pet-chat.js`：`memoryBlock(characterId)`、vault 四块、`pushVaultCandidate`、`rememberEvents(events, characterId)` 全部按角色

**验证**：`memoryCardPromptBlock('qq')` 小鲸鱼 **2 160 字**，`memoryCardPromptBlock('qq','claude')` **0 字**；
vault 路径分别是 `characters/char-mw5ku2rk/memory/vault.json` 与 `characters/claude/memory/vault.json`；
小C 0 条、小鲸鱼 6 条。

## 二、P1 记忆卡按角色维护

- 插件 `memory-card.js` 用 `AsyncLocalStorage` 携带「当前上下文角色的记忆路径」：
  `pathsNow()` 默认当前角色，维护时用 `withCharacterPaths(paths, fn)` 包住，**不会串台**
- `runMemoryCardMaintenance({ characterId })`；`biliStateDir()` 跟着上下文走
- 定时器改为**遍历所有角色**（`listCharacters()`），每个角色单独维护、日志带 `[小C]` 前缀；
  容量告警只对当前角色发（不拿小C 的卡给主人报「满了」）
- 首次维护已为小C 建好：`characters/claude/memory/`（卡 247 字、四份输出文件）

## 三、P2 小C 自己的 vault

- 路径、注入、自动捕获全部按角色
- `vault-inbox.js` 改成**按角色 drain**（候选队列也分开）
- CLI：`vault.mjs --character claude add|list|due|done`
- 仓库/网页/客厅：`pet-chat` 的 `rememberEvents` 写各自 inbox（客厅 round-robin 本来就带 characterId）

## 四、P3/P4

- 周记：`memory-weekly.mjs --character claude --days 7`（读她的卡、写她的 `memory-weekly.md`、入她的 vault）
- 图谱：`pet-chat` enqueue 前加 `（对话角色：<名字>）`，召回时能看出是谁说的（暂不硬隔离）

## 五、验证

```text
小鲸鱼卡注入 2160 字 / 小C 0 字           ← P0
vault 路径分离，小C 0 条 / 小鲸鱼 6 条      ← P0/P2
test-memory-vault 11 组断言通过
test-memory-card 27/27 通过
```

## 六、生效与残余

- `pet-chat` / `memory-card` / `vault-inbox` 在插件进程里，**要 DSH 重启**才加载新逻辑
- 桥接（QQ）仍用当前角色（小鲸鱼），无需改
- 小C 目前只有网页单聊 + 客厅，没有 QQ/B站；她的卡会随着聊天慢慢长
- P4 只做了标记，没做「按角色过滤召回」；图谱仍是共享的
