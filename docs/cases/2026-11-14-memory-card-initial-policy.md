# Case：记忆卡「永远快满」——initial 锁死 90% + 扩容

> 2026-11-14。现象：压缩刚做完 79.9%，但算下来 1~2 天又会满，而且压不动。

## 一、量化

| 指标 | 当时 |
|---|---|
| 卡渲染字数 | 47 921 / 60 000 = 79.9% |
| 受保护（压缩删不掉） | 43 920 = **73.2%** |
| 压缩最多能回收 | **4 001 字** |
| 日增（11-13 / 11-14） | 19 878 / 18 272 字；平常日 700~1 500 |

按这个节奏：平常日约 12 天满，按近 8 天平均约 2 天满，再来一个 11-13 那样的日子当天就满。
满一次只能压回 73%，4 天后又满——会一直在 100% 附近抖动，每次抖动都在牺牲非受保护的群聊/B站记忆。

## 二、根因

`refreshInitialState` 按「关系第几天」给 owner 记录打 `initial`：

```js
initialProbabilityForOffset(offsetDays)  // <10 天 0.9，<20 天 0.55，<30 天 0.3
record.isInitial = stableInitialChance(record.id) < probability
```

关系才第 8 天 → 90% 的主人记录被锁，387 条里 **346 条 initial（41 172 字，91.7%）**，而压缩规则明确不动 `isInitial`。

## 三、改法（A+B）

**A. 扩容**（配置，立即生效，不用重启）
`~/.dsh/surfcore/config.json` → `memoryCard.warnChars: 60000 → 120000`。
prompt 注入本来就有硬上限（网页 2600 字 / B站 2000 字），所以容量翻倍**不增加 token**，只是压缩触发点后移。
（备份：`~/.dsh/_backups/20261114-sync/config-before-warnchars.json`）

**B. 改 initial 策略**（代码，需重启 DSH）
不再按天数随机锁 90%，改成：**初次相遇 1 条 + 重要性最高的前 N 条**（默认 30，`card.meta.initialKeep` 可调）。
其余记录正常参与衰减/压缩；早期细节仍可从 `memory-card-full.jsonl`（全量档案，569 条）检索，不会消失。

## 四、效果（拿真卡 dry-run，没写盘）

```text
initial: 346 条 -> 31 条（9 798 字）
受保护地板: 43 920 (73.2%) -> 8 721 (14.5%)
压缩可回收: 4 001 -> 39 200 字
状态: 47 921/60 000 (79.9%) -> 47 922/120 000 (39.9%)
```

也就是说：即使她把卡填到 120k，压缩也能一路压回 ~9k，而不是卡在 73%。

## 五、取舍与风险

- **代价**：早期几十条对话会从「常驻卡」淡出（全量档案仍在，可按关键词检索）；这是拿「记得住全部」换「不会满」。
- **旧曲线函数**（`initialProbabilityForOffset`）保留并继续单测，作为参考；不再参与标记。
- **测试**：`scripts/test-memory-card.mjs` 里「前10/中10/后10」那条改成新策略断言（27 个用例全过）；
  `test-memory-card-api.mjs` 通过。
- **没动**：`minOwnerImportance`（65）仍然保证主人重要记忆不被遗忘；`pinned`/初次相遇永远保留。

## 六、生效与回滚

- A：插件按 mtime 重读 `config.json`，**已经生效**（`memoryCardStatusNow()` 现在 39.9%）。
- B：`src/memory-card.js` 在插件/桥接进程里，**重启 DSH 后**按新策略重算标记（下次维护也会重算）。
- 回滚：config 用备份覆盖；代码 `git revert` 对应提交即可（旧逻辑完整保留为函数）。

## 七、验证

```text
node --test scripts/test-memory-card.mjs            → 27/27 pass
node --test plugins/surfcore/scripts/test-memory-card-api.mjs → 1/1 pass
memoryCardStatusNow() → { chars: 47922, percent: 39.9, warnChars: 120000 }
真卡 dry-run（不写盘）→ initial 346→31，地板 43920→8721
```
