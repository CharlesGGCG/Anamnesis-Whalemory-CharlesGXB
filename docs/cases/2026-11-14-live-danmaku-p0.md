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
