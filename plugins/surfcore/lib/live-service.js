// 直播服务（P0）：弹幕接入 + 读弹幕导演 + L2D 舞台，一个入口给 pet-api 用。
//
// config.json 的 live 段（都可选）：
//   { "enabled": false, "room": 14103983,
//     "danmaku": { "read": true, "minGapMs": 20000, "nameGapMs": 300000, "maxPerMinute": 3 },
//     "stageUrl": "http://127.0.0.1:61945" }
import fs from 'node:fs'
import path from 'node:path'
import { createLiveDanmaku } from './live-danmaku.js'
import { createLiveStage } from './live-stage.js'
import { createLiveDirector } from './live-director.js'

function loadLiveConfig(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'))
    return raw?.live && typeof raw.live === 'object' ? raw.live : {}
  } catch { return {} }
}

export function createLiveService({ stateDir, pluginLog = () => {}, config = null, chat = null } = {}) {
  const cfg = config || loadLiveConfig(stateDir)
  const room = Number(cfg.room) || 14103983
  const stage = createLiveStage({ baseUrl: String(cfg.stageUrl || 'http://127.0.0.1:61945'), onLog: pluginLog })
  const characterId = String(cfg.characterId || '')
  const brain = chat && typeof chat.chat === 'function'
    ? (event) => chat.chat({ text: `「${event.name}」说：${event.text}`, identity: 'owner', web: false, live: true, ...(characterId ? { characterId } : {}) })
    : null
  const director = createLiveDirector({ stage, brain, config: cfg.danmaku || {}, log: pluginLog })
  const danmaku = createLiveDanmaku({ room, onEvent: (event) => director.push(event), onLog: pluginLog })
  let startedAt = 0
  let lastError = ''

  async function start() {
    try {
      director.start()
      await danmaku.start()
      startedAt = Date.now()
      lastError = ''
      pluginLog(`[直播] 已启动：房间 ${room}`)
      return { ok: true, room }
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 200)
      pluginLog('[直播] 启动失败：', lastError)
      return { ok: false, error: lastError }
    }
  }

  async function stop() {
    director.stop()
    await danmaku.stop()
    startedAt = 0
    pluginLog('[直播] 已停止')
    return { ok: true }
  }

  async function test({ author = '测试观众', text = '主播晚上好' } = {}) {
    return director.push({ kind: 'danmaku', name: String(author).slice(0, 40), text: String(text).slice(0, 200), dmid: `test-${Date.now()}`, at: Date.now() })
  }

  return {
    start,
    stop,
    test,
    status: () => ({
      enabled: cfg.enabled === true,
      room,
      startedAt,
      lastError,
      danmaku: danmaku.status(),
      director: director.status(),
      stage: stage.status(),
    }),
    stage,
    director,
  }
}
