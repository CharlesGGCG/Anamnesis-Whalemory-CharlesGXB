# Case：外置记忆库（vault）——关键词召回 + 承诺清单

> 2026-11-14。需求原话：「是否可以做一个外置记忆库把记忆放进去包括重要信息重要承诺在放进去后获得对应的关键词，她可以每隔一段时间因为在对话中触发关键词而调用对应的库」。

## 一、为什么现有三层不够

| 层 | 召回方式 | 缺口 |
|---|---|---|
| `memory-card` | 全量塞 prompt | 有字数上限；满了要压缩，压缩就可能丢掉要紧的那条（这次压缩就把 14 条 B站 记忆压掉了） |
| `vector-memory` | 语义相似 | 概率性：承诺可能排在十条闲聊后面；每次召回要算 embedding |
| `memory-graph` | 实体/关系 | 偏「相关」，不保证「必须想起」 |

外置库是第四层：**不占 prompt 容量、按关键词确定性命中、承诺另走定时清单**。

## 二、设计

**存储**：`<角色记忆目录>/vault.json`（当前 `~/.dsh/surfcore/characters/char-mw5ku2rk/memory/vault.json`），
每条：

```json
{"id":"v_…","kind":"promise|fact|preference|event","text":"答应周末陪主人去江边散步",
 "keywords":["周末","江边散步","下雨"],"entities":["周日","江边"],
 "importance":4,"status":"pending|active|done","dueAt":"2026-11-16",
 "source":"qq|web|cli|card-import","hits":0,"lastHitAt":""}
```

**写入三条路**

1. 手动：`node vault.mjs add --text "…" [--kind promise] [--due 2026-11-16]`
2. 自动：桥接/桌宠发现主人说「答应/说好/别忘了/下次/生日/纪念日/记住…」→ 追加一行到 `vault-inbox.jsonl`
   → 插件进程每分钟 drain，用 LLM 抽关键词后入库
3. 从记忆卡搬：`node vault.mjs import-card --min-importance 80`（先 `--dry` 看）

**关键词**：写入时一次小调用（SiliconFlow `deepseek-ai/DeepSeek-V3`）抽 3~6 个关键词 + 实体；
失败自动退回规则抽取（时间词 + 引号内容 + 短片段）。实测：

```
输入：答应周末陪主人去江边散步，下雨就改到周日
规则：周末、周日
LLM ：周末、江边散步、下雨、改期、陪伴、主人 ｜ 实体：周日、江边 ｜ kind=promise
```

**召回**

- 每轮唤醒拿「当前这句话」做本地匹配（毫秒级、零 token）：精确关键词 > 实体 > 时间词，命中最多 3 条注入；
- 承诺清单不看关键词：`pending` 的最多 5 条，默认 **4 小时最多一次**；B站 每次醒来 `ignoreGap` 必带。

**注入点（三处）**

| 位置 | 说明 |
|---|---|
| `src/bridge.js` `buildWakePromptV2` | 塞进 `base` 数组（⚠️ 唤醒正文真正生效的只有 base；`memoryCardLine` 那些是 11-08 改版后的死代码） |
| `plugins/surfcore/lib/pet-chat.js` `buildChatSystemPrompt` | 新增 `vault` 段；**只对主人开**，访客不注入（隐私） |
| `plugins/surfcore/lib/scheduler.js` `identityContextLines` | B站 醒来必带承诺清单（`touch:false`，不占 4 小时配额） |

**自动收录**：`plugins/surfcore/lib/vault-inbox.js` 每分钟 drain，失败整批回滚，重复正文按 `addVaultEntry` 去重。

## 三、取舍

- **为什么不直接用向量**：承诺/生日/雷区必须确定性命中；向量是「相似度前 K」，会漏，而且每次召回要花 embedding。
- **关键词为什么用 LLM**：规则抽词在中文长句上很弱（上面例子只抽出 2 个词）；LLM 一次约 2.6~3.3 秒、只在写入时发生，可接受。
- **承诺为什么单独一条通道**：只靠关键词，主人不提「周末」她就永远想不起来；定时清单兜住「必须想起」。
- **B站 也注入**：B站 是她自己的浏览/思考会话；但这是公开面，所以只放「还没兑现」这种她该处理的事，且不注入主人私聊原文。

## 四、验证

```text
node scripts/test-memory-vault.mjs
→ ok memory-vault: 写入/命中/承诺/去重/队列 9 组断言通过

CLI（临时 DSH_HOME）：
  add --text "答应周末陪主人去江边散步，下雨就改到周日" --no-llm --due 2026-11-16
  → v_4b04d411c9 [promise/pending] ★4，关键词：周末、周日
  list / search "周末去散步吗" → 命中并渲染「[承诺] …（2026-11-16 前）」

LLM 抽词：见上（2.6~3.3s，关键词 6 个 + 实体 2 个）
import-card --dry --min-importance 80 → 2 条（65 是 45 条，太宽，别直接导）
```

## 五、生效与回滚

- `src/bridge.js`（QQ）→ **重启桥接**即可；
- `pet-chat.js` / `scheduler.js` / `vault-inbox.js`（插件进程）→ **重启 DSH** 后生效；
- 回滚：删 `vault.json` / `vault-inbox.jsonl` 即清空；去掉三处注入行即停用，互不影响。

## 六、残余

- 自动捕获是「句式命中」，可能收进「答应但其实是玩笑」的句子；先观察一周，必要时加 `--no-auto` 或在 CLI 里删。
- `import-card` 的阈值导入很粗（65 分会把闲聊也收进来），默认只建议 ≥80 且先 `--dry`。
- 关键词匹配是子串匹配，短词（如「雨」）可能误命中；目前限制关键词长度和权重，仍建议人工过一眼。
