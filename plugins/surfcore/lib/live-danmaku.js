// B站直播间弹幕接入（常驻 WS，Node 原生 WebSocket + zlib，无第三方依赖）。
//
//   const dm = createLiveDanmaku({ room: 14103983, onEvent, onLog })
//   await dm.start(); dm.status(); await dm.stop()
//
// 事件统一成：
//   { kind:'danmaku'|'gift'|'sc'|'guard', uid, name, text, gift, num, price, dmid, at }
// 只读监听，不发言。
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { accountBili } from '../tools/lib/state-paths.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

function readCredentials() {
  const p = accountBili('credentials.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
    if (!raw[k] || String(raw[k]).trim() === '') throw new Error(`凭据文件缺少 ${k}`)
  }
  return raw
}

function cookieOf(cred) {
  return `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`
}

function wbiQuery(nav, params) {
  const d = nav?.data ?? nav
  const keyOf = (u) => String(u).slice(String(u).lastIndexOf('/') + 1, String(u).lastIndexOf('.'))
  const raw = keyOf(d?.wbi_img?.img_url ?? '') + keyOf(d?.wbi_img?.sub_url ?? '')
  const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  const wts = Math.round(Date.now() / 1000)
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const merged = { ...params, wts }
  const qs = Object.keys(merged).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(merged[k]))}`).join('&')
  return `${qs}&w_rid=${crypto.createHash('md5').update(qs + mixin).digest('hex')}`
}

export function createLiveDanmaku({ room, onEvent = () => {}, onLog = () => {} } = {}) {
  const roomId = Number(room) || 0
  let ws = null
  let heartbeat = null
  let reconnectTimer = null
  let running = false
  let attempts = 0
  let connectedAt = 0
  let lastEventAt = 0
  let received = 0
  let statusText = 'idle'

  function packet(op, str) {
    const body = Buffer.from(String(str), 'utf8')
    const buf = Buffer.alloc(16 + body.length)
    buf.writeUInt32BE(16 + body.length, 0)
    buf.writeUInt16BE(16, 4)
    buf.writeUInt16BE(1, 6)
    buf.writeUInt32BE(op, 8)
    buf.writeUInt32BE(1, 12)
    body.copy(buf, 16)
    return buf
  }

  function emit(ev) {
    received += 1
    lastEventAt = Date.now()
    try { onEvent(ev) } catch (error) { onLog('[live-danmaku] 事件处理失败：', String(error?.message ?? error)) }
  }

  function handleFrame(buf) {
    let off = 0
    while (off + 16 <= buf.length) {
      const total = buf.readUInt32BE(off)
      if (total < 16 || off + total > buf.length) break
      const hlen = buf.readUInt16BE(off + 4)
      const ver = buf.readUInt16BE(off + 6)
      const op = buf.readUInt32BE(off + 8)
      const body = buf.subarray(off + hlen, off + total)
      if (ver === 3) { try { handleFrame(zlib.brotliDecompressSync(body)) } catch {} }
      else if (ver === 2) { try { handleFrame(zlib.inflateSync(body)) } catch {} }
      else if (op === 5) handleJson(body.toString('utf8'))
      off += total
    }
  }

  function handleJson(text) {
    let o
    try { o = JSON.parse(text) } catch { return }
    const cmd = String(o?.cmd ?? '')
    if (cmd.startsWith('DANMU_MSG')) {
      const d = o.info ?? []
      emit({
        kind: 'danmaku', uid: d[2]?.[0], name: String(d[2]?.[1] ?? '').slice(0, 40),
        text: String(d[1] ?? '').slice(0, 200), dmid: String(d[0]?.[5] ?? ''), at: Date.now(),
      })
      return
    }
    if (cmd.startsWith('SUPER_CHAT_MESSAGE')) {
      const d = o.data ?? {}
      emit({ kind: 'sc', uid: d.uid, name: String(d.user_info?.uname ?? '').slice(0, 40), text: String(d.message ?? '').slice(0, 200), price: Number(d.price ?? 0), at: Date.now() })
      return
    }
    if (cmd.startsWith('SEND_GIFT')) {
      const d = o.data ?? {}
      emit({ kind: 'gift', uid: d.uid, name: String(d.uname ?? '').slice(0, 40), gift: String(d.giftName ?? ''), num: Number(d.num ?? 1), price: Number(d.price ?? 0), at: Date.now() })
      return
    }
    if (cmd.startsWith('GUARD_BUY')) {
      const d = o.data ?? {}
      emit({ kind: 'guard', uid: d.uid, name: String(d.username ?? d.uname ?? '').slice(0, 40), gift: String(d.gift_name ?? '舰长'), num: Number(d.num ?? 1), at: Date.now() })
    }
  }

  async function connectOnce() {
    const cred = readCredentials()
    const H = { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}`, origin: 'https://live.bilibili.com', cookie: cookieOf(cred) }
    const getJson = async (url) => {
      const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(12000) })
      return JSON.parse(await res.text())
    }
    const info = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`)
    if (info.code !== 0) throw new Error(`get_info code=${info.code} ${info.message ?? ''}`)
    const realId = info.data?.room_id ?? roomId
    const nav = await getJson('https://api.bilibili.com/x/web-interface/nav')
    const uid = Number(nav.data?.mid ?? 0)
    const dan = await getJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${wbiQuery(nav, { id: realId, type: 0 })}`)
    if (dan.code !== 0) throw new Error(`getDanmuInfo code=${dan.code} ${dan.message ?? ''}`)
    const token = dan.data?.token
    const host = (dan.data?.host_list ?? [])[0]
    if (!token || !host) throw new Error('拿不到弹幕 token / 服务器')
    const url = `wss://${host.host}:${host.wss_port}/sub`

    statusText = `connecting ${host.host}`
    ws = new WebSocket(url)
    try { ws.binaryType = 'arraybuffer' } catch {}
    ws.addEventListener('open', () => {
      try { ws.send(packet(7, JSON.stringify({ uid, roomid: realId, protover: 3, platform: 'web', type: 2, key: token }))) } catch {}
      connectedAt = Date.now()
      attempts = 0
      statusText = `connected room=${realId}`
      onLog(`[live-danmaku] 已连接房间 ${realId}（${host.host}）`)
      heartbeat = setInterval(() => { try { ws.send(packet(2, '[object Object]')) } catch {} }, 30000)
      try { heartbeat.unref?.() } catch {}
    })
    ws.addEventListener('message', async (ev) => {
      try {
        const ab = ev.data instanceof ArrayBuffer ? ev.data : await ev.data?.arrayBuffer?.()
        if (ab) handleFrame(Buffer.from(ab))
      } catch {}
    })
    ws.addEventListener('close', () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
      statusText = 'closed'
      if (running) scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      statusText = 'error'
      if (running) scheduleReconnect()
    })
  }

  function scheduleReconnect() {
    if (reconnectTimer || !running) return
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, attempts))
    attempts += 1
    statusText = `reconnect in ${Math.round(delay / 1000)}s`
    onLog(`[live-danmaku] 断开，${Math.round(delay / 1000)}s 后重连`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connectOnce().catch((error) => {
        onLog('[live-danmaku] 重连失败：', String(error?.message ?? error).slice(0, 160))
        scheduleReconnect()
      })
    }, delay)
    try { reconnectTimer.unref?.() } catch {}
  }

  async function start() {
    if (running) return
    running = true
    try {
      await connectOnce()
    } catch (error) {
      onLog('[live-danmaku] 连接失败：', String(error?.message ?? error).slice(0, 200))
      scheduleReconnect()
    }
  }

  async function stop() {
    running = false
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
    try { ws?.close() } catch {}
    ws = null
    statusText = 'stopped'
  }

  return {
    start,
    stop,
    status: () => ({ running, room: roomId, statusText, connectedAt, lastEventAt, received }),
  }
}
