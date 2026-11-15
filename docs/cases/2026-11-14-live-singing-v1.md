# Case：直播 P1 唱歌 v1（曲库 + 点歌 + OBS 播放 + 歌词）

> 2026-11-14。目标：弹幕「点歌 歌名」→ 她答应 → 放歌（音频进 OBS）→ 歌词滚动；先不要求口型同步。

## 一、为什么这么拆

- L2D 的 `/api/studio/command` 只支持 `greeting/silent/speech`，**播不了歌曲文件**
- OBS 媒体源（`ffmpeg_source`）能把音频直接混进直播，还能查 `mediaCursor/mediaDuration` 做歌词对时
- 口型同步需要 L2D 新增音频接口（v1.5），v1 先用歌词 + 歌声，画面保持她的 Live2D

## 二、实现

| 模块 | 作用 |
|---|---|
| `songbook.js` | 点歌解析（点歌/唱一首/来一首…）、模糊匹配、LRC 解析、队列（同人冷却/上限/版权过滤） |
| `song-player.js` | OBS WS：建 `鲸鱼歌声`（ffmpeg_source，挪到画布外只出声）+ `鲸鱼歌词`（text_ft2_source_v2，底部）；`play/status/setLyrics/stop` |
| `live-service.js` | 事件里识别点歌 → 入队 → 回一句「好，下一首《X》」；每 2.5s 检查队列；播放期间 `director.setPaused(true)`，按 LRC 更新歌词，结束恢复 |
| `songbook.mjs` | 曲库维护：list / add / remove |
| 配置 | `live.song = { enabled, queueMax, cooldownMs }`；曲库在 `characters/<id>/live/songs.json` |

版权：`license: own|cover|unknown`，**unknown 默认不播**。

## 三、验证

```text
test-songbook.mjs → 解析/匹配/LRC/队列 4 组断言通过
独立播放测试：play test-tone.wav → mediaState=PLAYING，cursor 2600/8000
OBS 截图：场景铺满 1920x1080 画布，底部出现「这是第一句歌词」
```

## 四、已知边界

- 搜到的歌只要 `title` 命中即可点；同名多版本取第一个
- 歌词位置固定在左下（x260,y900@1080p），字号 48；要居中/双行再说
- 播放期间**暂停读弹幕**（director.paused），唱完恢复
- 口型不同步 —— v1.5 需要 L2D 暴露「播放本地音频 + 振幅驱动口型」接口
- 测试音 `test-tone.wav` 是自检用素材，正式曲库需要自己放音频/LRC

## 五、全链路实测（2026-11-14 21:48）

```text
/live/test "点歌 测试音"
→ push: { ok: true, song: "测试音" }
→ t+2.5s singing=true playing=测试音 paused=true
→ t+5s   lyrics="这是第一句歌词"
→ t+7.5s lyrics="这是第二句歌词"
→ t+10s  singing=false paused=false（唱完恢复读弹幕）
plugin.log: 晚风 点了《测试音》→ 开始播放 test-tone.wav → 这首结束
```

**点歌 → 排队 → 播放 → 歌词 → 恢复读弹幕** 全链路通过。

- 歌声进 OBS 混音器（媒体源在画布外，只出声不上画面）
- 唱歌期间 `director.paused=true`，不抢话
- 附带小修：唱完清空 `lastLyric`
- 待办：点歌那句「好，下一首《X》」需要 `audioReady=true`（OBS 交互点一次「启用声音」），否则只有文字日志
