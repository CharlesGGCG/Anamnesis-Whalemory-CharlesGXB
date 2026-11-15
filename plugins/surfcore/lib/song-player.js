// 唱歌执行器：两条路
//   A) 口型同步（优先）：把歌曲 WAV 注册成 L2D 的「语音任务」，用 /api/studio/command
//      以 speech 播放 → 页面用 WebAudio 分析音频驱动口型，嘴型跟歌走。
//   B) 兜底：OBS 媒体源（ffmpeg_source）播歌，音频进直播但没有口型。
// 歌词：两种情况都用 OBS 文本源（text_ft2_source_v2）滚，位置在画面底部。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MEDIA_SOURCE = '鲸鱼歌声'
const LYRICS_SOURCE = '鲸鱼歌词'
const L2D_ROOT = 'C:/dsh/jingyu/Jingyu 1.5 Integrated'
const L2D = 'http://127.0.0.1:61945'
const VOICE_DIR = path.join(L2D_ROOT, '.local', 'studio-voice')

function readPassword() {
  const p = path.join(process.env.APPDATA || '', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')).server_password || ''
}

/** WAV 时长（秒）：走 RIFF chunk，找不到就 0。 */
export function wavDuration(file) {
  try {
    const b = fs.readFileSync(file)
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return 0
    let off = 12
    let byteRate = 0
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4)
      const size = b.readUInt32LE(off + 4)
      if (id === 'fmt ' && off + 16 <= b.length) byteRate = b.readUInt32LE(off + 16)
      if (id === 'data') return byteRate ? size / byteRate : 0
      off += 8 + size + (size % 2)
    }
  } catch {}
  return 0
}

function l2dClient(state) {
  return (state?.clients || []).find((c) => c.ready) || null
}

export function createSongPlayer({ sceneName = '', onLog = () => {} } = {}) {
  let scene = sceneName
  let lastError = ''
  let mode = ''

  async function withObs(fn) {
    const pw = readPassword()
    const sha = (s) => crypto.createHash('sha256').update(s).digest()
    const b64 = (b) => Buffer.from(b).toString('base64')
    const ws = new WebSocket('ws://127.0.0.1:4455')
    let seq = 0
    const pending = new Map()
    const call = (type, data = {}) => new Promise((res, rej) => {
      const id = String(++seq)
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ op: 6, d: { requestId: id, requestType: type, requestData: data } }))
    })
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data))
      if (m.op === 0 && m.d?.authentication) {
        const { challenge, salt } = m.d.authentication
        const secret = b64(sha(pw + salt))
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, authentication: b64(sha(secret + challenge)) } }))
        return
      }
      if (m.op === 7) {
        const p = pending.get(m.d.requestId); if (!p) return; pending.delete(m.d.requestId)
        if (m.d.requestStatus.result) p.res(m.d.responseData || {})
        else p.rej(new Error(`${type}: ${m.d.requestStatus?.comment || m.d.requestStatus?.code}`))
      }
    })
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', () => rej(new Error('连不上 OBS（4455）')))
      setTimeout(() => rej(new Error('OBS 连接超时')), 6000)
    })
    await new Promise((r) => setTimeout(r, 300))
    try {
      if (!scene) scene = (await call('GetSceneList')).currentProgramSceneName
      return await fn(call)
    } finally {
      try { ws.close() } catch {}
    }
  }

  async function ensureSources(call) {
    const inputs = await call('GetInputList')
    const names = new Set((inputs.inputs || []).map((i) => i.inputName))
    if (!names.has(MEDIA_SOURCE)) {
      await call('CreateInput', {
        sceneName: scene, inputName: MEDIA_SOURCE, inputKind: 'ffmpeg_source',
        inputSettings: { is_local_file: true, local_file: '', restart_on_activate: true, close_when_inactive: false },
      })
    }
    if (!names.has(LYRICS_SOURCE)) {
      await call('CreateInput', {
        sceneName: scene, inputName: LYRICS_SOURCE, inputKind: 'text_ft2_source_v2',
        inputSettings: { text: '', font: { face: 'Microsoft YaHei', size: 48, flags: 0 }, color1: 0xFFFFFFFF, color2: 0xFFFFFFFF, outline: true, outline_size: 2, outline_color: 0xFF000000 },
      })
    }
    try { await call('SetInputSettings', { inputName: LYRICS_SOURCE, inputSettings: { font: { face: 'Microsoft YaHei', size: 48, flags: 0 } } }) } catch {}
    const items = await call('GetSceneItemList', { sceneName: scene })
    const find = (n) => (items.sceneItems || []).find((x) => x.sourceName === n)
    const mediaItem = find(MEDIA_SOURCE)
    if (mediaItem) {
      await call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: mediaItem.sceneItemId,
        sceneItemTransform: { positionX: -3000, positionY: -3000, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 64, boundsHeight: 64 },
      })
    }
    const lyricItem = find(LYRICS_SOURCE)
    if (lyricItem) {
      await call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: lyricItem.sceneItemId,
        sceneItemTransform: { positionX: 260, positionY: 900, boundsType: 'OBS_BOUNDS_NONE' },
      })
    }
    try { if (lyricItem) await call('SetSceneItemIndex', { sceneName: scene, sceneItemId: lyricItem.sceneItemId, sceneItemIndex: 999 }) } catch {}
    const stageItem = find('场景页')
    if (stageItem) {
      await call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: stageItem.sceneItemId,
        sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080 },
      })
    }
  }

  // ── A) 口型同步：注册成 L2D 语音任务 ─────────────────────────────
  async function prepareLipSync(file) {
    const id = crypto.randomBytes(6).toString('hex')
    const dir = path.join(VOICE_DIR, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(file, path.join(dir, 'speech.wav'))
    const duration = wavDuration(file)
    const job = {
      id, status: 'ready', text: '', instruction: '', audioUrl: `/api/studio/voice/audio?id=${id}`,
      duration, sampleRate: 44100, segments: [], createdAt: Date.now() / 1000,
    }
    fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(job, null, 2)}\n`, 'utf8')
    return { id, duration }
  }

  async function playLipSync(id) {
    const st = await fetch(`${L2D}/api/studio/state`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
    const client = l2dClient(st)
    if (!client) throw new Error('没有就绪的直播页面')
    if (client.telemetry && client.telemetry.audioReady === false) throw new Error('场景页还没启用声音')
    const res = await fetch(`${L2D}/api/studio/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: client.id, action: 'play', audio: 'speech', speechId: id }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.error) throw new Error(data?.error || `command HTTP ${res.status}`)
    mode = 'lipsync'
    onLog('[唱歌] 口型同步播放已开始')
    return data
  }

  async function lipSyncStatus() {
    const st = await fetch(`${L2D}/api/studio/state`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
    const c = l2dClient(st)
    return { playing: Boolean(c?.telemetry?.playing), audioTime: Number(c?.telemetry?.audioTime) || 0 }
  }

  function cleanupLipSync(id) {
    if (!id) return
    try { fs.rmSync(path.join(VOICE_DIR, id), { recursive: true, force: true }) } catch {}
  }

  async function stopLipSync() {
    await fetch(`${L2D}/api/studio/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }), signal: AbortSignal.timeout(8000),
    }).catch(() => {})
  }

  // ── B) 兜底：OBS 媒体源 ─────────────────────────────────────────
  async function playMedia(file) {
    mode = 'media'
    return withObs(async (call) => {
      await ensureSources(call)
      await call('SetInputSettings', { inputName: MEDIA_SOURCE, inputSettings: { is_local_file: true, local_file: file, restart_on_activate: true } })
      await call('TriggerMediaInputAction', { inputName: MEDIA_SOURCE, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' })
      onLog('[唱歌] 用 OBS 媒体源播放（无口型）')
      return { ok: true }
    })
  }

  async function mediaStatus() {
    return withObs(async (call) => call('GetMediaInputStatus', { inputName: MEDIA_SOURCE }))
  }

  async function prepareLyrics() {
    return withObs(async (call) => ensureSources(call)).catch(() => {})
  }

  async function setLyrics(text) {
    return withObs(async (call) => {
      await call('SetInputSettings', { inputName: LYRICS_SOURCE, inputSettings: { text: String(text ?? '').slice(0, 200) } })
    })
  }

  async function stop() {
    await stopLipSync()
    return withObs(async (call) => {
      try { await call('TriggerMediaInputAction', { inputName: MEDIA_SOURCE, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }) } catch {}
      try { await call('SetInputSettings', { inputName: LYRICS_SOURCE, inputSettings: { text: '' } }) } catch {}
      onLog('[唱歌] 已停止')
      return { ok: true }
    }).catch(() => ({ ok: false }))
  }

  return {
    prepareLipSync, playLipSync, lipSyncStatus, stopLipSync, cleanupLipSync,
    playMedia, mediaStatus, prepareLyrics, setLyrics, stop,
    statusInfo: () => ({ scene, lastError, mode, media: MEDIA_SOURCE, lyrics: LYRICS_SOURCE }),
  }
}
