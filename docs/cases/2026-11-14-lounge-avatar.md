# Case：客厅里小C 的头像还是鲸鱼

> 2026-11-14。现象：whaleweb 客厅（群聊）里小C 说话，气泡头像是小鲸鱼的。

## 现象 → 根因

- 客厅消息在 `server.mjs` 里是 `{ sender, name, text }`，`sender` 已经是 `char-mw5ku2rk` / `claude`，数据没错
- 渲染在 `public/index.html`：客厅轮询里对每条非主人消息调 `addBubble('her', ...)`，
  而 `bubbleNode` 的头像只认 `herAvatar()`——它只看 `currentRoom`，
  在客厅（`currentRoom === 'lounge'`）永远返回鲸鱼头像
- 同一个 bug 也影响「小C 房间」的历史消息：`loadHistory()` 虽然拿到了 `characterId`，但没传给 `addBubble`

## 修法

`public/index.html`：

```js
function avatarFor(characterId) {
  return String(characterId || '') === 'claude' ? '/claude-144.webp' : '/avatar-144.webp'
}
function herAvatar() { return avatarFor(ROOM_CHARS[currentRoom] || '') }

function bubbleNode(role, text, characterId = '') { ... av.src = cid ? avatarFor(cid) : herAvatar() ... }
function addBubble(role, text, characterId = '') { ... }
```

- 客厅：`addBubble('her', text, m.sender)`
- 小C 房间历史：`addBubble(..., characterId)`
- 默认不传时保持原行为（当前房间头像），不破坏其它调用点

## 验证

```text
node --check（两段内联 script 均通过）
重启 WhalewebServer → GET / 含 avatarFor=True
lounge.json 最近消息 sender 确认为 char-mw5ku2rk / claude
```

## 生效与回滚

- 静态文件，重启 `WhalewebServer` 即生效；回滚 = 用上一版 `index.html` 覆盖并重启
- 部署目录 `C:\dsh\whaleweb` 与仓库镜像 `whaleweb/public/index.html` 已同步（哈希一致）
