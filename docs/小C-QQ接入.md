# 小C 接 QQ（独立角色桥接）

> 2026-11-14。小C 之前只有网页单聊 + 客厅；这份是给她**单独一个 QQ 号**的接法。
> 现成脚本：`scripts/qq-character-bridge.mjs`；纯逻辑：`src/character-qq.js`；测试：`scripts/test-character-qq.mjs`。

## 一、为什么不用第二个 DSH 会话

小C 不需要工具/Linux/shell，她只需要「人设 + 记忆 + 说话」。所以走：

```
小号 QQ ── SnowLuma#2（OneBot WS）── qq-character-bridge ── pet-api /chat（characterId=claude）── 回复
```

好处：复用她刚建好的**人格卡 / 记忆卡 / vault / 日记 / 图谱**，不占 DSH 会话、不碰鲸鱼的 QQ 工具链、封控面更小。
代价：她没有鲸鱼那套 QQ 工具（发表情包/看视频/搜网页），只会聊天。

## 二、今晚拿到小号后的步骤

### 1. 起第二个 SnowLuma

- 单独目录、单独端口（例：OneBot WS `3012`、控制台 `3112`），登录小号
- SnowLuma 是第三方专有运行时，**不随仓库分发**，需要你自己装/起（EULA §5.4）
- 记下它的 **WebSocket 地址** 和 **accessToken**

### 2. 填配置

```bash
node scripts/qq-character-bridge.mjs --character claude --init
```

会生成 `~/.dsh/surfcore/characters/claude/qq.json`：

```json
{
  "enabled": true,
  "wsUrl": "ws://127.0.0.1:3012",
  "accessToken": "第二个 SnowLuma 的令牌",
  "selfQQ": "小号 QQ 号",
  "petApi": { "baseUrl": "", "token": "" },
  "allow": { "private": ["你的主号 QQ"], "groups": [], "allowAllPrivate": false },
  "groupTrigger": ["小C", "小c"],
  "limits": { "maxLen": 300, "minGapMs": 1200 }
}
```

- `petApi` 留空会自动读 `~/.dsh/surfcore/pet/host.json` 的地址和令牌
- **白名单为空 = 谁都不回**（安全默认），至少把主号填进 `allow.private`

### 3. 先只读验证

```bash
node scripts/qq-character-bridge.mjs --character claude --dry
```

用主号给小号发一句：日志里应出现 `收到 private:xxx → ...` 和 `[dry] 不回复`。
这一步只验证「收得到」，不发消息、不花钱。

### 4. 真跑

```bash
node scripts/qq-character-bridge.mjs --character claude
```

前台跑通后再常驻。注册计划任务（登录时启动、失败重试）：

```powershell
$action = New-ScheduledTaskAction -Execute 'node.exe' -Argument '"C:\dsh\repos\surfcore\scripts\qq-character-bridge.mjs" --character claude' -WorkingDirectory 'C:\dsh\repos\surfcore'
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'XiaocQQBridge' -Action $action -Trigger $trigger -Force
```

停止：`Stop-ScheduledTask -TaskName XiaocQQBridge`；回滚：把 `enabled` 改回 `false`。

## 三、行为规则（脚本内置）

- **私聊**：白名单内必回
- **群聊**：群要在 `allow.groups` 里，且 @ 她或消息里出现「小C」才回
- 白名单外一律忽略并记日志
- 每人限速 `minGapMs`（默认 1.2 秒）；长回复按句切分、每条 ≤ `maxLen`
- 她回「[沉默]」就真不发
- 收到的消息进她的记忆卡（10 分钟维护一次）、说「答应/记住」进她的 vault、22 点后自动写她的日记

## 四、风险与边界

| 风险 | 说明 / 处理 |
|---|---|
| 同 IP 双号封控 | 小号只做私聊、低频率；不要在群里大量发言；先跑几天观察 |
| SnowLuma 不随仓库分发 | 需要你自己装第二个实例；本程序只连接、不部署 |
| 令牌泄漏 | 配置在 `~/.dsh` 下，不进仓库；日志只记 ws 地址不记 token |
| 她和鲸鱼搞混 | 两条完全独立的链路：她走 pet-api（角色 claude），鲸鱼走 bridge（当前角色） |
| 记忆串台 | 已按角色隔离（卡/vault/图谱/日记），QQ 只是她的又一个入口 |

## 五、验证清单

- [ ] `node scripts/test-character-qq.mjs` 5 组断言通过（文本/白名单/叫名/切分/沉默）
- [ ] `--init` 生成模板且不覆盖已有配置
- [ ] `enabled=false` 时拒绝启动（已测）
- [ ] `--dry` 能收到主号私聊并打印
- [ ] 真跑后她的回复出现在 QQ，且 `characters/claude/memory/` 10 分钟内出现这条记录
