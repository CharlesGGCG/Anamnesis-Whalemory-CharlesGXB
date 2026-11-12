import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
const PORT = Number(cfg.port) || 8787
const INVITE = String(cfg.inviteCode || '').trim()
const DEV_INVITE = String(cfg.devInviteCode || '').trim()
const COOKIE = 'ww_invite'
const VAL_GUEST = crypto.createHash('sha256').update(INVITE).digest('hex')
const VAL_OWNER = DEV_INVITE ? crypto.createHash('sha256').update(DEV_INVITE).digest('hex') : ''

const HOST_FILE = String(cfg.hostFile || '').trim() || path.join(HOME, '.dsh', 'surfcore', 'pet', 'host.json')
function readHost() {
  try {
    const h = JSON.parse(fs.readFileSync(HOST_FILE, 'utf8'))
    return {
      baseUrl: String(h.baseUrl || '').replace(/\/+$/, ''),
      token: String(h.token || ''),
      api: h.api || '/dsh-surfcore/pet-api',
    }
  } catch { return null }
}

async function petChat(text, identity = 'guest') {
  const h = readHost()
  if (!h || !h.token) return { ok: false, error: '她还没准备好（本机服务未就绪）' }
  try {
    const r = await fetch(`${h.baseUrl}${h.api}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pet-token': h.token },
      body: JSON.stringify({ text, identity, web: true, debug: identity === 'owner' }),
    })
    return await r.json()
  } catch (e) { return { ok: false, error: String(e.message) } }
}

async function petStatus() {
  const h = readHost()
  if (!h || !h.token) return { ok: false, online: false }
  try {
    const r = await fetch(`${h.baseUrl}${h.api}/status`, { headers: { 'x-pet-token': h.token } })
    return await r.json()
  } catch { return { ok: false, online: false } }
}

async function petHistory(limit = 60, identity = 'guest') {
  const h = readHost()
  if (!h || !h.token) return { ok: false, messages: [] }
  try {
    const r = await fetch(`${h.baseUrl}${h.api}/history?limit=${limit}&identity=${identity}`, { headers: { 'x-pet-token': h.token } })
    return await r.json()
  } catch { return { ok: false, messages: [] } }
}

// 表情包：读 nekowhale 目录 + 代理 GIF
const STICKER_CATALOG = String(cfg.stickerCatalog || path.join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-nekowhale-stickers', 'meta', 'nekowhale.json'))
const STICKER_BASE = String(cfg.stickerBase || 'http://127.0.0.1:3080/x-nekowhale-stickers/s/').replace(/\/+$/, '')
let stickerList = []
try {
  const cat = JSON.parse(fs.readFileSync(STICKER_CATALOG, 'utf8'))
  stickerList = (Array.isArray(cat.stickers) ? cat.stickers : []).map((s) => {
    const stem = String((s.id || '').split('/').pop() || s.id)
    const code = stem.split('_')[0]
    return {
      id: stem,
      name: stem.slice(code.length + 1) || stem,
      hash: String(s.hash || ''),
      emotion: String(s.emotion || ''),
      tags: Array.isArray(s.tags) ? s.tags.slice(0, 6) : [],
      text: String(s.text || ''),
      desc: String(s.desc || ''),
    }
  }).filter((s) => s.hash)
} catch { stickerList = [] }

// 把模型主动给出的 `[sticker:名字或情绪]` 解析成一张具体表情（名字精确、情绪随机抽）。
function resolveStickerRef(ref) {
  const r = String(ref || '').trim()
  if (!r) return null
  let s = stickerList.find((x) => x.name === r) || stickerList.find((x) => x.id === r)
  if (!s) {
    const pool = stickerList.filter((x) => x.emotion === r)
    if (pool.length) s = pool[Math.floor(Math.random() * pool.length)]
  }
  if (!s) return null
  return { hash: s.hash, name: s.name, emotion: s.emotion, text: s.text }
}

// 把 `[动作:伸懒腰]` 派给 Live2D 工作台：先查快捷预设直接重播，命中不了再走 DSH 编排（fire-and-forget）。
const L2D_BASE = 'http://127.0.0.1:61945'
async function triggerLive2DAction(action) {
  const a = String(action || '').trim().slice(0, 24)
  if (!a) return
  try {
    // 1) 快捷预设：按名字模糊匹配（伸个懒腰 → 伸懒腰），直接重播，省 DSH 编排。
    const pr = await fetch(`${L2D_BASE}/api/presets`).then((r) => r.json()).catch(() => null)
    const list = Array.isArray(pr?.presets) ? pr.presets : []
    const hit = list.find((p) => {
      const n = String(p?.name || '').trim()
      return n && (a.includes(n) || n.includes(a))
    })
    if (hit?.id) {
      await fetch(`${L2D_BASE}/api/presets/play`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: hit.id }),
      }).catch(() => {})
      return
    }
    // 2) 没命中预设 → DSH 编排 → 校验 → 播放。
    const r1 = await fetch(`${L2D_BASE}/api/planner/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: a }),
    })
    const j1 = await r1.json()
    const taskId = j1?.id || j1?.taskId || j1?.task?.id
    if (!taskId) return
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const st = await fetch(`${L2D_BASE}/api/planner/state`).then((r) => r.json()).catch(() => null)
      const task = (st?.tasks || []).find((t) => String(t.id) === String(taskId))
      if (!task) continue
      if (task.status === 'validated') {
        await fetch(`${L2D_BASE}/api/planner/execute`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }),
        }).catch(() => {})
        return
      }
      if (['cancelled', 'failed', 'error'].includes(task.status)) return
    }
  } catch {}
}

// 左栏「她看视频」：观看队列 + 最近观看历史（读 DSH 状态目录）。
const STATE_DIR = String(cfg.stateDir || '').trim() || path.dirname(path.dirname(HOST_FILE))
const WATCH_QUEUE = String(cfg.watchQueue || '').trim() || path.join(STATE_DIR, 'pet', 'watch-queue.json')

function readWatchQueue() {
  try {
    const j = JSON.parse(fs.readFileSync(WATCH_QUEUE, 'utf8'))
    return Array.isArray(j && j.items) ? j.items : []
  } catch { return [] }
}

function writeWatchQueue(items) {
  try {
    fs.mkdirSync(path.dirname(WATCH_QUEUE), { recursive: true })
    const tmp = `${WATCH_QUEUE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8')
    fs.renameSync(tmp, WATCH_QUEUE)
  } catch {}
}

// 尽量从 B站 公开接口补标题/UP/时长；失败就退回只存 BV 号。
async function biliMeta(bvid) {
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
    const j = await r.json()
    if (j && j.code === 0 && j.data) {
      return {
        title: String(j.data.title || '').trim(),
        up: String(j.data.owner?.name || '').trim(),
        duration: Number(j.data.duration) || 0,
        pic: String(j.data.pic || '').trim(),
      }
    }
  } catch {}
  return null
}

function readWatchHistory(limit = 12) {
  const base = path.join(STATE_DIR, 'characters')
  let target = ''
  let mt = 0
  try {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, 'bili', 'watch-history.jsonl')
      try {
        const s = fs.statSync(f)
        if (s.mtimeMs > mt) { mt = s.mtimeMs; target = f }
      } catch {}
    }
  } catch {}
  if (!target) return []
  try {
    const lines = fs.readFileSync(target, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).reverse()
  } catch { return [] }
}

function parseCookies(req) {
  const out = {}
  const c = req.headers.cookie || ''
  for (const part of c.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}
function identityOf(req) {
  const v = parseCookies(req)[COOKIE]
  if (DEV_INVITE && v === VAL_OWNER) return 'owner'
  if (INVITE && v === VAL_GUEST) return 'guest'
  return ''
}
function authorized(req) {
  return identityOf(req) !== ''
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (p === '/api/invite') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
    let body = ''
    for await (const chunk of req) body += chunk
    let code = ''
    try { code = String(JSON.parse(body).code || '') } catch {}
    let val = ''
    let identity = ''
    if (DEV_INVITE && code === DEV_INVITE) { val = VAL_OWNER; identity = 'owner' }
    else if (code && code === INVITE) { val = VAL_GUEST; identity = 'guest' }
    if (val) {
      res.setHeader('Set-Cookie', `${COOKIE}=${val}; Path=/; HttpOnly; Max-Age=${90 * 24 * 3600}; SameSite=Lax`)
      return send(res, 200, { ok: true, identity })
    }
    return send(res, 401, { ok: false, error: '邀请码不对' })
  }

  if (p === '/api/auth') {
    const id = identityOf(req)
    return send(res, 200, { authorized: id !== '', identity: id, dev: id === 'owner' })
  }

  if (p === '/api/chat') {
    const id = identityOf(req)
    if (!id) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    let body = ''
    for await (const chunk of req) body += chunk
    let text = ''
    try { text = String(JSON.parse(body).text || '') } catch {}
    if (!text.trim()) return send(res, 400, { ok: false, error: '空消息' })
    const r = await petChat(text, id)
    if (r.ok && r.reply) {
      const sticker = resolveStickerRef(r.reply.stickerRef)
      if (sticker) r.reply.sticker = sticker
      delete r.reply.stickerRef
      const action = String(r.reply.action || '').trim()
      delete r.reply.action
      if (action && id === 'owner') triggerLive2DAction(action)
    }
    return send(res, r.ok ? 200 : 502, r)
  }

  if (p === '/api/status') {
    if (!authorized(req)) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    return send(res, 200, await petStatus())
  }

  if (p === '/api/history') {
    const id = identityOf(req)
    if (!id) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60))
    return send(res, 200, await petHistory(limit, id))
  }

  if (p === '/api/stickers') {
    if (!authorized(req)) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    return send(res, 200, { ok: true, count: stickerList.length, stickers: stickerList })
  }

  if (p === '/api/activity') {
    const id = identityOf(req)
    if (!id) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    const out = { ok: true, history: readWatchHistory(12) }
    if (id === 'owner') {
      out.queue = readWatchQueue()
      try { out.status = await petStatus() } catch { out.status = { ok: false } }
    }
    return send(res, 200, out)
  }

  if (p === '/api/watch') {
    if (identityOf(req) !== 'owner') return send(res, 403, { ok: false, error: '只有主人能加视频' })
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
    let body = ''
    for await (const chunk of req) body += chunk
    let bvid = ''
    try { bvid = String(JSON.parse(body).bvid || '').trim() } catch {}
    bvid = (bvid.match(/BV[0-9A-Za-z]{10}/) || [bvid])[0]
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return send(res, 400, { ok: false, error: '请输入正确的 BV 号（如 BV1St4Y6jEkc）' })
    const items = readWatchQueue()
    let item = items.find((x) => x.bvid === bvid)
    if (!item) {
      const meta = await biliMeta(bvid)
      item = { bvid, title: meta?.title || bvid, up: meta?.up || '', duration: meta?.duration || 0, pic: meta?.pic || '', addedAt: new Date().toISOString(), status: 'queued' }
      items.push(item)
      writeWatchQueue(items)
    }
    return send(res, 200, { ok: true, count: items.length, item })
  }

  // Live2D 工作台代理（仅开发者）——把 127.0.0.1:61945 挂在 /l2d/ 下，走邀请码闸门。
  if (p === '/l2d' || p.startsWith('/l2d/')) {
    if (identityOf(req) !== 'owner') return send(res, 403, { ok: false, error: '只有开发者能访问 Live2D 工作台' })
    const target = 'http://127.0.0.1:61945' + (p === '/l2d' ? '/' : p.slice('/l2d'.length))
    try {
      let body
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        body = Buffer.concat(chunks)
      }
      const headers = { ...req.headers }
      delete headers.host
      delete headers.cookie
      delete headers['content-length']
      const r = await fetch(target, { method: req.method, headers, body, redirect: 'manual' })
      const ct = r.headers.get('content-type') || 'application/octet-stream'
      let buf = Buffer.from(await r.arrayBuffer())
      // 文本响应：把工作台的绝对路径 /model /data /api 等重写到 /l2d/ 前缀，并把 127.0.0.1:61945 去掉。
      if (/text|javascript|json|svg|xml|wasm/.test(ct)) {
        buf = Buffer.from(buf.toString('utf8')
          .replace(/https?:\/\/127\.0\.0\.1:61945/g, '')
          .replace(/(["'`])(\/(?:model|data|api|vendor|pet\.html|scene-experiment\.html|community\.html|lab\.html|stocking-study\.html))/g, '$1/l2d$2'), 'utf8')
      }
      const outHeaders = { 'content-type': ct }
      if (r.headers.get('location')) outHeaders.location = r.headers.get('location')
      res.writeHead(r.status, outHeaders)
      res.end(buf)
      return
    } catch { return send(res, 502, { ok: false, error: 'Live2D 服务不可达' }) }
  }

  if (p.startsWith('/s/')) {
    if (!authorized(req)) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    const hash = p.slice(3).replace(/\.gif$/i, '').replace(/[^a-f0-9]/gi, '')
    if (!hash) return send(res, 404, 'not found', 'text/plain')
    try {
      const r = await fetch(`${STICKER_BASE}/${hash}.gif`)
      if (!r.ok) return send(res, 404, 'not found', 'text/plain')
      const buf = Buffer.from(await r.arrayBuffer())
      res.writeHead(200, { 'content-type': 'image/gif', 'content-length': buf.length, 'cache-control': 'public, max-age=86400' })
      res.end(buf)
      return
    } catch { return send(res, 502, 'proxy error', 'text/plain') }
  }

  if (p === '/') {
    // 支持直接带邀请码的链接：/?invite=CODE 自动放行
    const q = url.searchParams.get('invite')
    if (q) {
      let val = ''
      if (DEV_INVITE && q === DEV_INVITE) val = VAL_OWNER
      else if (INVITE && q === INVITE) val = VAL_GUEST
      if (val) {
        res.setHeader('Set-Cookie', `${COOKIE}=${val}; Path=/; HttpOnly; Max-Age=${90 * 24 * 3600}; SameSite=Lax`)
      }
    }
    res.setHeader('Cache-Control', 'no-store')
    return send(res, 200, indexHtml, 'text/html; charset=utf-8')
  }

  // 静态文件（头像等）
  {
    const rel = p.replace(/^\/+/, '').replace(/\.\./g, '')
    if (rel) {
      const file = path.join(__dirname, 'public', rel)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css', '.js': 'text/javascript' }
        const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream'
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
        fs.createReadStream(file).pipe(res)
        return
      }
    }
  }

  return send(res, 404, 'not found', 'text/plain')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`whaleweb listening on http://127.0.0.1:${PORT}`)
})

// WebSocket 升级代理：把 /l2d/ 下的 WS 转发给 Live2D 工作台（仅开发者）。
server.on('upgrade', (req, socket, head) => {
  let p = '/'
  try { p = new URL(req.url, 'http://localhost').pathname } catch {}
  if (p !== '/l2d' && !p.startsWith('/l2d/')) { socket.destroy(); return }
  if (identityOf(req) !== 'owner') { socket.destroy(); return }
  const targetPath = p === '/l2d' ? '/' : p.slice('/l2d'.length)
  const upstream = net.connect(61945, '127.0.0.1', () => {
    let header = `${req.method} ${targetPath} HTTP/${req.httpVersion}\r\n`
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() !== 'host') header += `${k}: ${v}\r\n`
    }
    header += 'host: 127.0.0.1:61945\r\n\r\n'
    upstream.write(header)
    if (head && head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})
