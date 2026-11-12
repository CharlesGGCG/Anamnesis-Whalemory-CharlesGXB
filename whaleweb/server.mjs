import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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
