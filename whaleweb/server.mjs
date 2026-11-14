import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
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

async function petChat(text, identity = 'guest', characterId = '', opts = {}) {
  const h = readHost()
  if (!h || !h.token) return { ok: false, error: '她还没准备好（本机服务未就绪）' }
  try {
    const r = await fetch(`${h.baseUrl}${h.api}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pet-token': h.token },
      body: JSON.stringify({ text, identity, web: true, debug: identity === 'owner', characterId, lounge: opts.lounge === true }),
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

async function petHistory(limit = 60, identity = 'guest', characterId = '') {
  const h = readHost()
  if (!h || !h.token) return { ok: false, messages: [] }
  try {
    const r = await fetch(`${h.baseUrl}${h.api}/history?limit=${limit}&identity=${identity}&characterId=${encodeURIComponent(characterId)}`, { headers: { 'x-pet-token': h.token } })
    return await r.json()
  } catch { return { ok: false, messages: [] } }
}

async function petScreenStatus() {
  const h = readHost()
  if (!h || !h.token) return { ok: false, enabled: false }
  try {
    const r = await fetch(`${h.baseUrl}${h.api}/screen`, { headers: { 'x-pet-token': h.token } })
    return await r.json()
  } catch { return { ok: false, enabled: false } }
}

async function petScreenConfig(patch) {
  const h = readHost()
  if (!h || !h.token) return { ok: false }
  try {
    const r = await fetch(`${h.baseUrl}${h.api}/screen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pet-token': h.token },
      body: JSON.stringify(patch || {}),
    })
    return await r.json()
  } catch { return { ok: false } }
}

// ── 房间：去鲸鱼房间 / 小C 房间（单聊），或客厅（群聊）────────────────
const ROOMS = [
  { id: 'whale', name: '鲸鱼的房间', type: 'private', characterId: 'char-mw5ku2rk' },
  { id: 'claude', name: '小C 的房间', type: 'private', characterId: 'claude' },
  { id: 'lounge', name: '客厅', type: 'group', characterId: '' },
]

// 客厅（群聊）状态：消息流 + round-robin 调度 + 每天额度
const LOUNGE_FILE = path.join(__dirname, 'lounge.json')
const LOUNGE_CHARS = [
  { id: 'char-mw5ku2rk', name: '小鲸鱼' },
  { id: 'claude', name: '小C' },
]
const LOUNGE_QUOTA = 40
let loungeMsgs = []
let loungeDaily = {}
let loungeTurn = 0
let loungeBusy = false

function loadLounge() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOUNGE_FILE, 'utf8'))
    loungeMsgs = Array.isArray(raw?.messages) ? raw.messages : []
    loungeDaily = raw?.daily && typeof raw.daily === 'object' ? raw.daily : {}
  } catch {}
}
function saveLounge() {
  try { fs.writeFileSync(LOUNGE_FILE, JSON.stringify({ messages: loungeMsgs, daily: loungeDaily }, null, 2)) } catch {}
}
loadLounge()

function loungeDayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
function loungeLeft(id) {
  const d = loungeDaily[loungeDayKey()] || {}
  return Math.max(0, LOUNGE_QUOTA - Number(d[id] || 0))
}
function loungeBump(id) {
  const k = loungeDayKey()
  loungeDaily[k] = loungeDaily[k] || {}
  loungeDaily[k][id] = (Number(loungeDaily[k][id] || 0)) + 1
}

// 客厅里「谁是谁」：给每个角色一句明确的关系说明，避免把彼此/主人认错。
const LOUNGE_RELATIONS = {
  'char-mw5ku2rk': '你是小鲸鱼，主人的女儿，叫主人「爸爸」；小C 是姐姐（大小姐）。',
  claude: '你是小C，这个家的姐姐（大小姐）；主人是主人本人；小鲸鱼是妹妹（女儿），会叫主人「爸爸」。',
}

async function loungeSpeak(id, name, ctx, { ownerJustSpoke = false, ownerText = '', force = false } = {}) {
  const others = LOUNGE_CHARS.filter((c) => c.id !== id).map((c) => c.name).join('、')
  const relation = LOUNGE_RELATIONS[id] || `你是「${name}」。`
  const instruction = ownerJustSpoke
    ? `主人刚刚说：「${String(ownerText).slice(0, 120)}」\n规则：你的第一句必须直接接住主人的这句话（他在跟你们说话；不要答非所问，不要只跟别人聊，也不要用旁白代替回答）。${force ? '主人已经等着了，必须回一句，不能沉默。' : '回 1~2 句，可以再带一句别人的话。'}`
    : '轮到你：想接就自然说 1~3 句；不想接只回复 [沉默]。'
  const prompt = [
    '【客厅 · 群聊，不是私聊】',
    `在场的人：主人（真人）、${LOUNGE_CHARS.map((c) => c.name).join('、')}。${relation}`,
    `你只代表你自己；不要替${others}或主人说话，也不要冒充他们；不要照搬私聊里的语境（如果看到私聊记录，那是另一个场景）。`,
    '',
    '最近的对话：',
    ctx || '（还没有人说话）',
    '',
    instruction,
  ].join('\n')
  const r = await petChat(prompt, 'owner', id, { lounge: true })
  const text = String(r?.reply?.text || '').trim()
  if (!text || text === '[沉默]' || text.includes('[沉默]')) return null
  return text.slice(0, 500)
}
function dayKeyOf(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
function loungeCtx(n = 20) {
  const today = dayKeyOf(Date.now())
  const older = loungeMsgs.filter((m) => dayKeyOf(m.at) !== today).slice(-8)
  const head = older.length
    ? `更早（昨天及以前；你们各自的记忆里也有）：\n${older.map((m) => `${m.name}：${String(m.text).slice(0, 50)}`).join('\n')}\n`
    : ''
  const recent = loungeMsgs.slice(-n).map((m) => `${dayKeyOf(m.at) === today ? '' : '[昨天] '}${m.name}：${m.text}`).join('\n')
  return head + recent
}
function loungePush(sender, name, text, fromOwner = false) {
  const msg = { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, sender, name, text, at: Date.now(), fromOwner }
  loungeMsgs.push(msg)
  if (loungeMsgs.length > 300) loungeMsgs = loungeMsgs.slice(-300)
  saveLounge()
  return msg
}
async function loungeTick() {
  if (loungeBusy) return
  loungeBusy = true
  try {
    const last = loungeMsgs[loungeMsgs.length - 1]
    // 主人刚说话：这次不算「自动聊天额度」，而且让两个人都能应一句（他说话不能没人搭）。
    const ownerJustSpoke = Boolean(last && (last.fromOwner === true || last.sender === 'owner'))
    const maxSpeakers = ownerJustSpoke ? LOUNGE_CHARS.length : 1
    let spokes = 0
    for (let i = 0; i < LOUNGE_CHARS.length && spokes < maxSpeakers; i++) {
      const idx = (loungeTurn + i) % LOUNGE_CHARS.length
      const ch = LOUNGE_CHARS[idx]
      loungeTurn = (idx + 1) % LOUNGE_CHARS.length
      if (!ownerJustSpoke && loungeLeft(ch.id) <= 0) continue
      if (last && last.sender === ch.id) continue
      const text = await loungeSpeak(ch.id, ch.name, loungeCtx(ownerJustSpoke ? 8 : 20), { ownerJustSpoke, ownerText: ownerJustSpoke ? String(last?.text || '') : '' })
      if (text) {
        loungePush(ch.id, ch.name, text)
        if (!ownerJustSpoke) loungeBump(ch.id)
        spokes += 1
      }
    }
    if (ownerJustSpoke && spokes === 0) {
      // 兜底：主人都开口了，不能没人应。
      const fb = LOUNGE_CHARS[loungeTurn % LOUNGE_CHARS.length]
      const text = await loungeSpeak(fb.id, fb.name, loungeCtx(6), { ownerJustSpoke: true, ownerText: String(last?.text || ''), force: true })
      if (text) loungePush(fb.id, fb.name, text)
    }
  } finally {
    loungeBusy = false
  }
}
setTimeout(() => { void loungeTick() }, 3000)
setInterval(() => { void loungeTick() }, 300000)

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

// 文本类响应做 brotli/gzip 压缩：页面 39KB 不压缩时慢网首屏很明显。
// 只压 >1KB 的文本/JSON/JS/SVG；图片和流不碰（content-length 必须与压缩后一致）。
function send(res, code, body, type = 'application/json; charset=utf-8') {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const headers = { 'content-type': type }
  const ae = String(res.req?.headers?.['accept-encoding'] || '')
  if (buf.length > 1024 && /^(text\/|application\/(json|javascript|xml)|image\/svg)/i.test(type)) {
    try {
      if (/\bbr\b/.test(ae)) {
        buf = zlib.brotliCompressSync(buf)
        headers['content-encoding'] = 'br'
        headers.vary = 'Accept-Encoding'
      } else if (/\bgzip\b/.test(ae)) {
        buf = zlib.gzipSync(buf)
        headers['content-encoding'] = 'gzip'
        headers.vary = 'Accept-Encoding'
      }
    } catch {}
  }
  headers['content-length'] = buf.length
  res.writeHead(code, headers)
  res.end(buf)
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
    let characterId = ''
    try {
      const j = JSON.parse(body)
      text = String(j.text || '')
      characterId = String(j.characterId || '').trim()
    } catch {}
    if (!text.trim()) return send(res, 400, { ok: false, error: '空消息' })
    const r = await petChat(text, id, characterId)
    if (r.ok && r.reply) {
      const sticker = resolveStickerRef(r.reply.stickerRef)
      if (sticker) r.reply.sticker = sticker
      delete r.reply.stickerRef
      const action = String(r.reply.action || '').trim()
      if (action && id === 'owner') triggerLive2DAction(action)
      // action 保留在 reply 里，前端把动作显示成括号注记
    }
    return send(res, r.ok ? 200 : 502, r)
  }

  if (p === '/api/rooms') {
    return send(res, 200, { ok: true, rooms: ROOMS })
  }

  if (p === '/api/lounge/messages') {
    if (!authorized(req)) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    return send(res, 200, { ok: true, messages: loungeMsgs.slice(-100), quota: LOUNGE_CHARS.map((c) => ({ id: c.id, name: c.name, left: loungeLeft(c.id), quota: LOUNGE_QUOTA })) })
  }

  if (p === '/api/lounge/say' && req.method === 'POST') {
    if (!authorized(req)) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    let body = ''
    for await (const chunk of req) body += chunk
    let text = ''
    try { text = String(JSON.parse(body).text || '').trim() } catch {}
    if (!text) return send(res, 400, { ok: false, error: '空消息' })
    loungePush('owner', '主人', text.slice(0, 500), true)
    send(res, 200, { ok: true })
    void loungeTick()
    return
  }

  // 开发者页状态：页面打开「思考后台」时每 5 秒上报一次心跳。
  // 两条防线（2026-11-13 主人定：她们不许监视开发者页）：
  //   ① 立刻把「陪看」关掉（老进程也认这个开关），页面收起/关闭再恢复原状；
  //   ② 写 devpage.json，新版屏幕感知读到就整轮跳过截屏（连图都不给视觉模型）。
  if (p === '/api/devpage' && req.method === 'POST') {
    if (identityOf(req) !== 'owner') return send(res, 403, { ok: false, error: '只有开发者能上报开发者页状态' })
    let body = ''
    for await (const chunk of req) body += chunk
    let open = false
    let visible = false
    try {
      const j = JSON.parse(body || '{}')
      open = j.open === true
      visible = j.visible === true
    } catch {}
    const surfDir = path.dirname(path.dirname(HOST_FILE))   // .../surfcore（避开 SYSTEM 的 os.homedir()）
    const file = path.join(surfDir, 'devpage.json')
    let prev = null
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (j.prevEnabled === true || j.prevEnabled === false) prev = j.prevEnabled
    } catch {}
    const pause = open && visible
    if (pause && prev === null) {
      let st = {}
      try { st = await petScreenStatus() } catch {}
      prev = st?.enabled === true
      if (prev) { try { await petScreenConfig({ enabled: false }) } catch {} }
    } else if (!pause && prev !== null) {
      if (prev) { try { await petScreenConfig({ enabled: true }) } catch {} }
      prev = null
    }
    try {
      const out = { open, visible, at: Date.now() }
      if (prev !== null) out.prevEnabled = prev
      fs.writeFileSync(file, JSON.stringify(out))
    } catch {}
    return send(res, 200, { ok: true, open, visible, paused: pause, prevEnabled: prev })
  }

  if (p === '/api/screen') {
    if (identityOf(req) !== 'owner') return send(res, 403, { ok: false, error: '只有开发者能控制屏幕感知' })
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let patch = {}
      try { patch = JSON.parse(body) } catch {}
      return send(res, 200, await petScreenConfig(patch))
    }
    return send(res, 200, await petScreenStatus())
  }

  if (p === '/api/screen/last-image') {
    if (identityOf(req) !== 'owner') return send(res, 403, { ok: false, error: '只有开发者能看截图' })
    // hostFile 在 C:/Users/Administrator/.dsh/surfcore/pet/，上溯一层就是 surfcore 目录（避开 SYSTEM 的 os.homedir()）
    const surfDir = path.dirname(path.dirname(HOST_FILE))
    const f = path.join(surfDir, 'screen-last.jpg')
    if (!fs.existsSync(f)) return send(res, 404, 'no image', 'text/plain')
    const buf = fs.readFileSync(f)
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-cache' })
    res.end(buf)
    return
  }

  if (p === '/api/status') {
    if (!authorized(req)) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    return send(res, 200, await petStatus())
  }

  if (p === '/api/history') {
    const id = identityOf(req)
    if (!id) return send(res, 401, { ok: false, error: '请先输入邀请码' })
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 60))
    const characterId = String(url.searchParams.get('characterId') || '')
    return send(res, 200, await petHistory(limit, id, characterId))
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
        const stat = fs.statSync(file)
        // 图片文件名带尺寸/版本（avatar-144.webp），可以放心长缓存；周更级别。
        const isImage = /\.(png|jpe?g|webp|svg|ico)$/i.test(rel)
        const headers = {
          'content-type': type,
          'cache-control': isImage ? 'public, max-age=604800, immutable' : 'public, max-age=86400',
          'last-modified': stat.mtime.toUTCString(),
        }
        // 文本类静态文件（css/js）也做压缩
        const ae = String(req.headers['accept-encoding'] || '')
        if (!isImage && stat.size > 1024 && /^(text\/|application\/(json|javascript|xml))/i.test(type)) {
          let buf = fs.readFileSync(file)
          try {
            if (/\bbr\b/.test(ae)) { buf = zlib.brotliCompressSync(buf); headers['content-encoding'] = 'br'; headers.vary = 'Accept-Encoding' }
            else if (/\bgzip\b/.test(ae)) { buf = zlib.gzipSync(buf); headers['content-encoding'] = 'gzip'; headers.vary = 'Accept-Encoding' }
          } catch {}
          headers['content-length'] = buf.length
          res.writeHead(200, headers)
          res.end(buf)
          return
        }
        res.writeHead(200, headers)
        fs.createReadStream(file).pipe(res)
        return
      }
    }
  }

  return send(res, 404, 'not found', 'text/plain')
})

// 开发者页心跳超时（20 秒）就恢复陪看：页面崩了/被直接关掉，也不让陪看永久停摆。
setInterval(async () => {
  try {
    const file = path.join(path.dirname(path.dirname(HOST_FILE)), 'devpage.json')
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const prev = j.prevEnabled
    if ((prev === true || prev === false) && Date.now() - Number(j.at || 0) > 20000) {
      if (prev) await petScreenConfig({ enabled: true })
      fs.writeFileSync(file, JSON.stringify({ open: false, visible: false, at: Date.now() }))
    }
  } catch {}
}, 10000).unref()

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
