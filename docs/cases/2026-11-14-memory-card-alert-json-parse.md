# Case：记忆卡容量告警从未送达（`JSON.parse` 对象）

> 2026-11-14，检查 DSH 重启后的运行状态时发现。

## 一、现象

`~/.dsh/surfcore/plugin.log` 每 10 分钟一条：

```
记忆卡告警通知失败："[object Object]" is not valid JSON
```

从 2026-11-14 07:16Z 起累计 **86 条**，而「记忆卡告警已私聊管理员」的成功记录 **0 条**。
记忆卡当时 100.1%（60065 字，`warnChars` 60000），也就是说：**卡早就该压缩了，主人一次都没收到提醒**。

## 二、根因

桥接的 `readBody()`（`src/bridge.js:4708`）**已经 `JSON.parse` 过**，resolve 的是对象；但记忆卡告警这个分支
（`src/bridge.js:9877`）又套了一层：

```js
const body = JSON.parse(await readBody() || '{}');   // ← JSON.parse(object)
```

Node 对非字符串调用 `JSON.parse` 会抛 `"[object Object]" is not valid JSON`。整条请求 500，
插件侧只把它当成「通知失败」记一条日志（日志可见、界面不可见），于是静默了 86 次。

**为什么只有这一处**：全仓 `src/bridge.js` 有 89 处 `await readBody()`，只有 notify 这处多包了一层。

## 三、修法

```js
// readBody() 已经解析成对象了；再 JSON.parse 会抛 `"[object Object]" is not valid JSON`
const body = await readBody();
```

一行，无行为变化（后续字段读取本来就按对象取）。

## 四、验证（2026-11-14 21:2x）

| 步骤 | 结果 |
|---|---|
| 修前直接 POST `/api/memory-card/notify` | `500 {"ok":false,"error":"\"[object Object]\" is not valid JSON"}` |
| 改一行 + `node --check src/bridge.js` | 通过 |
| 用 `restart()` 重启桥接 | `ok:true`，新 pid 28400；`/api/status` 正常，SnowLuma `connected:true / accountOnline:true` |
| 修后直接 POST 同一请求 | `200 {"ok":true}` —— 真的私聊出去了 |
| 立刻再调一次（走 `callBridge`） | `{"ok":true,"skipped":"cooldown"}` —— 10 分钟冷却生效，不会刷屏 |

## 五、残余

- 告警文案里的字数是 `60065/0 字`（`maxChars:0` 表示不设硬上限，百分比用的是 `warnChars`）。
  只是难看，不影响告警；要改得动 `memory-card.js` 的 notify 传参，可下次一起。
- 修的是 `src/bridge.js`（QQ 桥接进程），所以**只需要重启桥接**，不用重启 DSH。
