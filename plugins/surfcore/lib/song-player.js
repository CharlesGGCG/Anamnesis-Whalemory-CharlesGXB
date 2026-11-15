// OBS 唱歌执行器：媒体源放歌（音频进 OBS）+ 文本源滚歌词。
//
// 为什么要放 OBS 里：L2D 的 /api/studio/command 只支持 greeting/silent/speech，
// 播不了歌曲文件；OBS 媒体源能直接把音频混进直播，且可查询播放进度。
//
// 每次操作建一条短 WS（OBS WebSocket v5），做完即关，不维护长连接状态。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MEDIA_SOURCE = '鲸鱼歌声'
const LYRICS_SOURCE = '鲸鱼歌词'

function readPassword() {
  const p = path.join(process.env.APPDATA || '', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')).server_password || ''
}

export function createSongPlayer({ sceneName = '', onLog = () => {} } = {}) {
  let scene = sceneName
  let lastError = ''

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
      if (!scene) {
        const list = await call('GetSceneList')
        scene = list.currentProgramSceneName
      }
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
    const items = await call('GetSceneItemList', { sceneName: scene })
    const find = (n) => (items.sceneItems || []).find((x) => x.sourceName === n)
    const mediaItem = find(MEDIA_SOURCE)
    if (mediaItem) {
      await call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: mediaItem.sceneItemId,
        sceneItemTransform: { positionX: -3000, positionY: -3000, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 64, boundsHeight: 64 },
      })
    }
    try { await call('SetInputSettings', { inputName: LYRICS_SOURCE, inputSettings: { font: { face: 'Microsoft YaHei', size: 48, flags: 0 }, outline: true, outline_size: 2, outline_color: 0xFF000000 } }) } catch {}
    const lyricItem = find(LYRICS_SOURCE)
    if (lyricItem) {
      await call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: lyricItem.sceneItemId,
        sceneItemTransform: { positionX: 260, positionY: 900, boundsType: 'OBS_BOUNDS_NONE' },
      })
    }
    const stageItem = find('场景页')
    if (stageItem) {
      await call('SetSceneItemTransform', {
        sceneName: scene, sceneItemId: stageItem.sceneItemId,
        sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080 },
      })
    }
  }

  async function play({ file, lrcText = '' }) {
    if (!fs.existsSync(file)) throw new Error(`歌曲文件不存在：${file}`)
    lastError = ''
    return withObs(async (call) => {
      await ensureSources(call)
      await call('SetInputSettings', { inputName: MEDIA_SOURCE, inputSettings: { is_local_file: true, local_file: file, restart_on_activate: true } })
      await call('TriggerMediaInputAction', { inputName: MEDIA_SOURCE, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' })
      if (lrcText) await call('SetInputSettings', { inputName: LYRICS_SOURCE, inputSettings: { text: lrcText } })
      onLog(`[唱歌] 开始播放：${path.basename(file)}`)
      return { ok: true }
    }).catch((error) => { lastError = String(error?.message ?? error); throw error })
  }

  async function status() {
    return withObs(async (call) => call('GetMediaInputStatus', { inputName: MEDIA_SOURCE }))
  }

  async function setLyrics(text) {
    return withObs(async (call) => {
      await call('SetInputSettings', { inputName: LYRICS_SOURCE, inputSettings: { text: String(text ?? '').slice(0, 200) } })
    })
  }

  async function stop() {
    return withObs(async (call) => {
      try { await call('TriggerMediaInputAction', { inputName: MEDIA_SOURCE, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }) } catch {}
      try { await call('SetInputSettings', { inputName: LYRICS_SOURCE, inputSettings: { text: '' } }) } catch {}
      onLog('[唱歌] 已停止')
      return { ok: true }
    }).catch(() => ({ ok: false }))
  }

  return { play, status, setLyrics, stop, statusInfo: () => ({ scene, lastError, media: MEDIA_SOURCE, lyrics: LYRICS_SOURCE }) }
}
