# Case：承诺到期闭环 + 每周记忆摘要

> 2026-11-14（北京时间 11-15）。升级计划 P1 的两项：承诺闭环、记忆卫生。

## 一、承诺到期闭环

**问题**：vault 里存了 `dueAt`，但只有「4 小时一次」的承诺清单，没有**到期**概念——答应「周末」和答应「明年」在提示词里长得一样。

**改法**（`src/memory-vault.js`）：

- `dueInfo(entry)`：按**北京时间**算天，返回 `今天到期 / 明天到期 / 已过期 N 天 / YYYY-MM-DD 前`
- `listDue({withinDays})`：列出 N 天内到期/过期的 pending 承诺（CLI `vault due`）
- `dueTodayPromptBlock()`：只列「今天到期 + 已过期」，**20 小时最多注入一次**（`meta.lastDuePromptAt`），避免每天刷屏
- 注入：`bridge.js`（QQ）和 `pet-chat.js`（网页/桌宠）在承诺清单后追加这个块
- CLI：`vault due [--days 3]`；兑现仍用 `vault done <id>`

渲染示例：`- [承诺] 答应周末陪主人去江边散步（已过期 2 天）`

## 二、每周记忆摘要（记忆卫生）

**问题**：卡里 7 天能积 300+ 条碎记录，没人整理就只剩流水账；敏感信息虽然摄取时已脱敏，但没有体检手段。

**改法**（`plugins/surfcore/tools/commands/memory-weekly.mjs`）：

```bash
node memory-weekly.mjs --days 7            # 生成周记 + 入库
node memory-weekly.mjs --dry               # 只看会写什么
node memory-weekly.mjs --scan              # 只体检敏感信息（手机号/证件/链接/密钥形状）
```

流程：读记忆卡最近 N 天记录 → LLM 压成 4~6 条「值得长期记住的事」（人物/承诺/情绪节点/偏好/事件，不要流水账）→ 每条过 `redactForMemory` → 追加到 `memory-weekly.md` → 写一条 `kind=event、source=weekly` 的 vault 记录（用 LLM 抽关键词，能被召回）。

## 三、验证（2026-11-14）

```text
node scripts/test-memory-vault.mjs
→ 10 组断言通过（新增：今天到期/过期 2 天/明天/6 天后/dueToday 只列到期/20h 冷却）

node memory-weekly.mjs --scan --days 7
→ 最近 7 天 339 条：手机号 0、证件号 0、链接 0、密钥形状 0、密码字样 0

node memory-weekly.mjs --days 7 --dry
→ 6 条（LLM），覆盖亲密关系/功能约定/记忆存储讨论/饮食偏好/自制歌曲/情绪节点

node memory-weekly.mjs --days 7
→ 写了 memory-weekly.md；vault 新增 v_74fa5f3389
   关键词：亲密关系、宝贝、功能改进、语音功能、记忆存储、小鸡炖蘑菇

bridge 重启 pid 30448；pet-chat / scheduler 动态 import 通过；test-memory-card 27/27
```

## 四、生效与残余

- `bridge.js`（QQ）已重启生效；`pet-chat.js`（网页/桌宠）和 `scheduler.js`（B站）**下次 DSH 重启**后带上 due 块
- 周记目前是**手动命令**，没排定时任务（排程需要用户明确同意）；建议每周日跑一次，或之后接 `schedule_create`
- 周记按**北京时间**切日期，所以 Denver 周日下午跑出来是北京时间周一
