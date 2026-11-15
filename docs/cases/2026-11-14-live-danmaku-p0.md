# Case：直播 P0 —— 读弹幕

> 2026-11-14。目标：真房间来弹幕 → 她念出来（先不回话）。

## 一、链路

```
B站直播间 14103983
  └─ live-danmaku.js（WS 常驻，Node 原生 WebSocket）
       事件规范化 → live-director.js（优先级/去重/同名冷却/限速）
       → live-stage.js（AgentL2D /api/studio/speak）
       → CosyVoice TTS + 口型 + 动作
```

控制面（pet-api）：

| 接口 | 作用 |
|---|---|
| `GET  /live/status` | 弹幕连接/队列/最近念的 |
| `POST /live/start` `/live/stop` | 开关 |
| `POST /live/test` | 塞一条假弹幕（本地验证，不碰真房间） |

CLI：`node plugins/surfcore/tools/commands/live.mjs status|start|stop|test`

## 二、实现要点

- `live-danmaku.js`：WBI 签名（`nav.data` 才是 wbi_img 所在）、`getDanmuInfo`、WS 鉴权包、30s 心跳、brotli/zlib 解包、断线指数退避（1→30s）
- 事件：`danmaku / gift / sc / guard`；进场事件忽略
- `live-director.js`：
  - 优先级 SC 100 > 礼物 80 > 上舰 70 > 普通 10
  - 默认 20s 一条、同名 5 分钟冷却、dmid 去重、每分钟最多 3 条
  - 念稿格式：`「昵称」说：内容` / `谢谢「昵称」的礼物`
  - 失败也记冷却，避免疯狂重试
- `live-stage.js`：自动找 `ready` 的 client；`audioReady=false` 时明确报错（提示先在 OBS 里交互点一次「启用声音」）
- 配置：`~/.dsh/surfcore/config.json` 的 `live` 段，`enabled:true` 时插件启动即连

## 三、验证

```text
node scripts/test-live-director.mjs      → 4 组断言通过（优先级/格式/过滤/执行）
node plugins/surfcore/tools/commands/danmaku.mjs live --room 14103983 --seconds 8 → 连接正常
live-danmaku 独立连接 12s → connected room=14103983（当前房间没人说话，0 条事件）
L2D /api/studio/state → 1 个 ready client（presentation=obs，audioReady=false）
```

## 四、生效与残余

- 插件重启后 `live` 服务自动起（config `live.enabled=true`）
- **`audioReady=false`**：OBS 浏览器源还没点过「启用声音」——OBS 里右键 `场景页` → 交互 → 点一下页面即可
- P0 只读不回；P0.5 接 pet-chat 生成回复；唱歌在 P1
- 真房间目前没开播/没人说话，等开播后再看真实弹幕流

## 五、验证结果（2026-11-14 19:24）

```text
live.mjs test --author 晚风 --text "晚上好，能听到吗"
→ readCount: 1
→ lastSpoken: 「晚风」说：晚上好，能听到吗
→ plugin.log: [直播] 念弹幕：「晚风」说：晚上好，能听到吗
```

**读弹幕链路已打通**：B站事件 → 队列 → 导演 → L2D speak → TTS/口型。

### 卡点：`audioReady=false`（已解决）

- OBS 场景页是 `?clean=1`，控制条被隐藏，没有「启用声音」按钮可点
- 处理：给 L2D 的 `web/scene-experiment.mjs` 打了一个最小补丁（备份 `scene-experiment.mjs.bak-20261114-audiounlock`）：
  `clean` 模式下在页面任意位置 `pointerdown` 也会调用 `audioInit()`
- 之后在 OBS 交互窗口里点一下，`audioReady` 变 true

### 另一个坑：`/live/*` 的 POST 会挂住

- `GET /live/status` 43ms 正常；`POST /live/start|stop|test` 全部超时（`/chat` POST 正常）
- 已给三个接口加 **12s 超时 + 错误 JSON**（不再无限挂），需要重启插件后验证根因

## 六、P0.5 回弹幕（2026-11-14 19:3x）

- `pet-chat` 新增 `live: true`：不读写私聊历史、不召回私聊图谱/vault、system 换成「直播中回应弹幕」，
  回复要短、口语、不旁白
- `live-director` 接 `brain`：选中一条弹幕后先跑一次大脑（20s 超时），
  把「念弹幕 + 她的回复」合成**一次** speak（省一次 TTS）；大脑失败自动退回只念弹幕
- `live-service` 注入 brain：`chat.chat({ text:'「名」说：内容', live:true, characterId })`
- 单测扩到 6 组：读+回合成一次、大脑失败降级

### 验证（2026-11-14 19:36）

```text
live.mjs test --author 晚风 --text "在吗，今天直播效果怎么样"
→ readCount: 1（2.5s）
→ lastSpoken: 「晚风」说：在吗，今天直播效果怎么样。在呢在呢，刚开播没多久，效果嘛……我自己觉得还行，你别嫌我话少就好。
```

**P0.5 通过**：念弹幕 + 她的回复合成一次 speak，语气是人设里的。

### 踩坑：L2D 语音引擎会被「半截合成」卡死

- 症状：`/api/studio/speak` 一直返回 `已有语音正在合成或收尾，请稍候`，`voice/cancel` 只改状态不释放 worker
- 触发：合成中途 OBS 场景页掉线/重载（client 离线）
- 处置：重启 `JingyuServer` 清空；`live-stage` 已加**自动清理 + 重试一次**，仍失败会在错误里提示「需要重启 JingyuServer」
