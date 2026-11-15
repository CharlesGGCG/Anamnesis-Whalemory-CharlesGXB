// 给「主人自己」的一套 OBS 直播间（独立场景集合，不动鲸鱼那套）。
//
//   node scripts/obs-owner-room.mjs
//
// 场景：桌面（显示器全屏）/ 游戏（全屏游戏捕获）/ 待机（深色画面+文字）
// 音频：麦克风（默认输入设备）；摄像头源预留但默认隐藏（没检测到摄像头也能用）
// 画布：1920x1080@60；推流服务沿用 OBS 当前设置（指向直播姬本地转推）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CFG = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')
const COLLECTION = '主人直播间'
const STANDBY_HTML = encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:radial-gradient(1200px 700px at 50% 30%,#1b2a3a,#0a1018)}
  body{display:flex;align-items:center;justify-content:center;color:#cfe3ff;font:600 64px/1.4 "Microsoft YaHei",sans-serif;letter-spacing:.08em}
  small{display:block;margin-top:18px;font-size:24px;opacity:.55;font-weight:400;letter-spacing:.2em}
</style><div>稍等一下，马上开播<small>BE RIGHT BACK</small></div>`)

function sha(s) { return crypto.createHash('sha256').update(s).digest() }
function b64(b) { return Buffer.from(b).toString('base64') }

const pw = JSON.parse(fs.readFileSync(CFG, 'utf8')).server_password
const ws = new WebSocket('ws://127.0.0.1:4455')
let seq = 0
const pending = new Map()
const call = (requestType, requestData = {}) => new Promise((res, rej) => {
  const requestId = String(++seq)
  pending.set(requestId, { res, rej, requestType })
  ws.send(JSON.stringify({ op: 6, d: { requestId, requestType, requestData } }))
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
    else p.rej(new Error(`${p.requestType}: ${JSON.stringify(m.d.requestStatus)}`))
  }
})
await new Promise((r, j) => { ws.addEventListener('open', r); setTimeout(() => j(new Error('timeout')), 8000) })
await new Promise((r) => setTimeout(r, 1200))

const ensureCollection = async () => {
  const cols = await call('GetSceneCollectionList')
  if (!(cols.sceneCollections || []).includes(COLLECTION)) {
    await call('CreateSceneCollection', { sceneCollectionName: COLLECTION })
    console.log(`创建场景集合：${COLLECTION}`)
  } else if (cols.currentSceneCollectionName !== COLLECTION) {
    await call('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION })
    console.log(`切到场景集合：${COLLECTION}`)
    await new Promise((r) => setTimeout(r, 800))
  }
}
const ensureScene = async (name) => {
  const list = await call('GetSceneList')
  if (!(list.scenes || []).some((s) => s.sceneName === name)) { await call('CreateScene', { sceneName: name }); console.log(`创建场景：${name}`) }
}
const ensureInput = async (sceneName, inputName, inputKind, settings = {}) => {
  const inputs = await call('GetInputList')
  if (!(inputs.inputs || []).some((i) => i.inputName === inputName)) {
    await call('CreateInput', { sceneName, inputName, inputKind, inputSettings: settings })
    console.log(`添加源：${inputName} (${inputKind}) → ${sceneName}`)
  }
}
const ensureItem = async (sceneName, sourceName, { visible = true } = {}) => {
  const items = await call('GetSceneItemList', { sceneName })
  if (!(items.sceneItems || []).some((x) => x.sourceName === sourceName)) {
    await call('CreateSceneItem', { sceneName, sourceName, sceneItemEnabled: visible })
  }
}
const fit = async (sceneName, sourceName, w = 1920, h = 1080, { x = 0, y = 0, scale = 1 } = {}) => {
  const items = await call('GetSceneItemList', { sceneName })
  const it = (items.sceneItems || []).find((s) => s.sourceName === sourceName)
  if (!it) return
  await call('SetSceneItemTransform', {
    sceneName, sceneItemId: it.sceneItemId,
    sceneItemTransform: {
      positionX: x, positionY: y, rotation: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 5,
      boundsWidth: w * scale, boundsHeight: h * scale,
    },
  })
}

await ensureCollection()
await ensureScene('桌面')
await ensureScene('游戏')
await ensureScene('待机')

// 麦克风（默认输入设备）
await ensureInput('桌面', '麦克风', 'wasapi_input_capture', { device_id: 'default' })
await ensureItem('桌面', '麦克风')
await ensureItem('游戏', '麦克风')
await ensureItem('待机', '麦克风')

// 桌面：显示器采集
await ensureInput('桌面', '显示器', 'monitor_capture', { capture_cursor: true, method: 2 })
// 显示器要用 monitor_id（OBS 32 的键名不是 monitor），从属性列表里取主显示器
try {
  const list = await call('GetInputPropertiesListPropertyItems', { inputName: '显示器', propertyName: 'monitor_id' })
  const item = (list.propertyItems || []).find((x) => x.itemEnabled && x.itemValue !== 'DUMMY')
  if (item) { await call('SetInputSettings', { inputName: '显示器', inputSettings: { monitor_id: item.itemValue, capture_cursor: true, method: 2 } }); console.log(`显示器：${item.itemName}`) }
} catch (e) { console.log('显示器选择失败：', String(e.message).slice(0, 80)) }
await ensureItem('桌面', '显示器')
await fit('桌面', '显示器')

// 游戏：整屏游戏捕获（没开游戏时是黑的，正常）
await ensureInput('游戏', '游戏采集', 'game_capture', { capture_mode: 'any_fullscreen' })
await ensureItem('游戏', '游戏采集')
await fit('游戏', '游戏采集')

// 待机：深色画面 + 文字
await ensureInput('待机', '待机画面', 'browser_source', { url: `data:text/html;charset=utf-8,${STANDBY_HTML}`, width: 1920, height: 1080, shutdown: false })
await ensureItem('待机', '待机画面')
await fit('待机', '待机画面')

// 摄像头：预留源，默认隐藏（有摄像头时在界面里点开、选设备）
await ensureInput('桌面', '摄像头', 'dshow_input', { video_device_id: '' })
// 没有摄像头就删掉这个源，避免日志里反复 DecodeDeviceId failed
try {
  const devs = await call('GetInputPropertiesListPropertyItems', { inputName: '摄像头', propertyName: 'video_device_id' })
  const cam0 = (devs.propertyItems || []).find((x) => x.itemEnabled)
  if (!cam0) { await call('RemoveInput', { inputName: '摄像头' }); console.log('没有检测到摄像头，已移除摄像头源') }
  else { await call('SetInputSettings', { inputName: '摄像头', inputSettings: { video_device_id: cam0.itemValue } }); await ensureItem('桌面', '摄像头', { visible: false }) }
} catch (e) { console.log('摄像头探测失败：', String(e.message).slice(0, 80)) }
const items = await call('GetSceneItemList', { sceneName: '桌面' })
const cam = (items.sceneItems || []).find((s) => s.sourceName === '摄像头')
if (cam) {
  await fit('桌面', '摄像头', 480, 270, { x: 1420, y: 760 })
  await call('SetSceneItemEnabled', { sceneName: '桌面', sceneItemId: cam.sceneItemId, sceneItemEnabled: false })
}

// 画布：1080p60
await call('SetVideoSettings', { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 })
await call('SetCurrentProgramScene', { sceneName: '桌面' })
console.log('主人直播间已就绪：场景 桌面 / 游戏 / 待机，画布 1920x1080@60，麦克风=默认输入')
ws.close()
process.exit(0)
