// OBS 直播场景初始化（OBS WebSocket v5，零依赖，用 Node 自带 WebSocket）。
//
//   node scripts/obs-setup.mjs status
//   node scripts/obs-setup.mjs setup
//
// 做的事情：
//   · 建/切到场景集合「鲸鱼直播」、场景「直播」
//   · 加浏览器源「场景页」→ http://127.0.0.1:61945/scene-experiment.html?clean=1
//     1280×720@30 + 控制音频（浏览器源自己出声，OBS 直接收）
//   · 画布 1280×720@30
// 不改推流密钥（B站推流码是敏感信息，由主人在 OBS 界面填）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOST = 'ws://127.0.0.1:4455'
const CFG = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')
const COLLECTION = '鲸鱼直播'
const SCENE = '直播'
const SRC = '场景页'
const URL = 'http://127.0.0.1:61945/scene-experiment.html?clean=1'

function password() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')).server_password || '' } catch { return '' }
}

import crypto from 'node:crypto'
function b64(buf) { return Buffer.from(buf).toString('base64') }
function sha(s) { return crypto.createHash('sha256').update(s).digest() }

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HOST)
    let seq = 0
    const pending = new Map()
    let identified = false
    const call = (requestType, requestData = {}) => new Promise((res, rej) => {
      seq += 1
      const requestId = String(seq)
      pending.set(requestId, { res, rej, requestType })
      ws.send(JSON.stringify({ op: 6, d: { requestId, requestType, requestData } }))
    })
    ws.addEventListener('open', () => {})
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.op === 0) {
        const hello = msg.d || {}
        const identity = { rpcVersion: 1, eventSubscriptions: 0 }
        if (hello.authentication) {
          const { challenge, salt } = hello.authentication
          const secret = b64(sha(password() + salt))
          identity.authentication = b64(sha(secret + challenge))
        }
        ws.send(JSON.stringify({ op: 1, d: identity }))
        return
      }
      if (msg.op === 2) { identified = true; resolve({ ws, call }); return }
      if (msg.op === 7) {
        const d = msg.d || {}
        const p = pending.get(d.requestId)
        if (!p) return
        pending.delete(d.requestId)
        if (d.requestStatus?.result) p.res(d.responseData || {})
        else p.rej(new Error(`${p.requestType}: ${d.requestStatus?.code} ${JSON.stringify(d.requestStatus || {})}`))
      }
    })
    ws.addEventListener('error', () => { if (!identified) reject(new Error('连不上 OBS WebSocket（4455），OBS 开了吗？')) })
    setTimeout(() => { if (!identified) reject(new Error('OBS WebSocket 认证超时')) }, 8000)
  })
}

const action = process.argv[2] || 'status'
const { ws, call } = await connect()
try {
  const version = await call('GetVersion')
  const scenes = await call('GetSceneList')
  const video = await call('GetVideoSettings')
  console.log(`OBS ${version.obsVersion} · websocket ${version.obsWebSocketVersion}`)
  console.log(`场景集合：${scenes.currentSceneCollectionName || '(未知)'}`)
  console.log(`当前场景：${scenes.currentProgramSceneName || '(无)'}`)
  console.log(`已有场景：${(scenes.scenes || []).map((s) => s.sceneName).join('、') || '(无)'}`)
  console.log(`画布：${video.baseWidth}x${video.baseHeight} → ${video.outputWidth}x${video.outputHeight} @${video.fpsNumerator}/${video.fpsDenominator}`)

  if (action === 'setup') {
    // 1) 场景集合（不存在就建）
    const cols = await call('GetSceneCollectionList')
    if (!(cols.sceneCollections || []).includes(COLLECTION)) {
      await call('CreateSceneCollection', { sceneCollectionName: COLLECTION })
      console.log(`已创建场景集合：${COLLECTION}`)
    } else if (cols.currentSceneCollectionName !== COLLECTION) {
      await call('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION })
      console.log(`已切到场景集合：${COLLECTION}`)
    }
    // 2) 场景
    let scenes2 = await call('GetSceneList')
    if (!(scenes2.scenes || []).some((s) => s.sceneName === SCENE)) {
      await call('CreateScene', { sceneName: SCENE })
      console.log(`已创建场景：${SCENE}`)
    }
    // 3) 浏览器源
    const inputs = await call('GetInputList')
    if (!(inputs.inputs || []).some((i) => i.inputName === SRC)) {
      await call('CreateInput', {
        sceneName: SCENE,
        inputName: SRC,
        inputKind: 'browser_source',
        inputSettings: {
          url: URL,
          width: 1280,
          height: 720,
          fps: 30,
          reroute_audio: true,
          shutdown: false,
          restart_when_active: false,
        },
      })
      console.log(`已添加浏览器源：${SRC} → ${URL}`)
    } else {
      await call('SetInputSettings', { inputName: SRC, inputSettings: { url: URL, reroute_audio: true, shutdown: false } })
      console.log(`浏览器源已存在，URL 已对齐`)
    }
    // 4) 铺满画布
    const items = await call('GetSceneItemList', { sceneName: SCENE })
    const it = (items.sceneItems || []).find((x) => x.sourceName === SRC)
    if (it) {
      await call('SetSceneItemTransform', {
        sceneName: SCENE, sceneItemId: it.sceneItemId,
        sceneItemTransform: {
          positionX: 0, positionY: 0, rotation: 0,
          boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 5,
          boundsWidth: 1280, boundsHeight: 720,
        },
      })
    }
    // 5) 画布
    await call('SetVideoSettings', {
      baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720,
      fpsNumerator: 30, fpsDenominator: 1,
    })
    await call('SetCurrentProgramScene', { sceneName: SCENE })
    console.log(`画布已设为 1280x720@30，切到「${SCENE}」`)
  }
} finally {
  try { ws.close() } catch {}
}
process.exit(0)
