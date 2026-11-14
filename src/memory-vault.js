/**
 * 外置记忆库（memory vault）—— 补「记忆卡装不下、向量召回想不起」的那一层。
 *
 * 为什么要它：
 *   · 记忆卡（memory-card）直接塞 prompt，有字数上限，满了要压缩，压缩保不齐丢的正是要命的那条；
 *   · 向量记忆按相似度召回，是概率性的——「答应你周日去散步」可能排在十条闲聊后面；
 *   · 这里存的是**必须想起来**的东西（重要事实 / 承诺 / 偏好 / 节点），
 *     每轮只做本地关键词匹配（毫秒级、零 token），命中才注入；承诺另有定时清单。
 *
 * 存储：<角色记忆目录>/vault.json（默认约 ~/.dsh/surfcore/characters/<id>/memory/vault.json）
 * 写入：手工（CLI / 设置页）或对话里自动捕获（vault-inbox.jsonl → 插件进程抽词入库）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { activeMemoryPaths } from './character-persona.js'

const DEFAULT_MIN_PROMISE_GAP_MS = 4 * 60 * 60 * 1000

function hashId(text) {
  return crypto.createHash('sha1').update(String(text ?? '').trim()).digest('hex').slice(0, 10)
}

export function vaultPaths() {
  const dir = activeMemoryPaths().dir
  return { dir, file: path.join(dir, 'vault.json'), inbox: path.join(dir, 'vault-inbox.jsonl') }
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text)
  } catch { return fallback }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function loadVault({ file = vaultPaths().file } = {}) {
  const raw = readJson(file, null)
  if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
    return { version: 1, updatedAt: '', meta: {}, ...raw }
  }
  return { version: 1, updatedAt: new Date().toISOString(), meta: {}, entries: [] }
}

export function saveVault(vault, { file = vaultPaths().file } = {}) {
  const next = { ...vault, version: 1, updatedAt: new Date().toISOString() }
  writeJson(file, next)
  return next
}

function normalizeKeywords(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const k = String(item ?? '').trim().slice(0, 20)
    if (k && !out.includes(k)) out.push(k)
  }
  return out.slice(0, 8)
}

/** 加一条；正文相同视为同一条（更新而不是重复占位）。 */
export function addVaultEntry(entry = {}, { file = vaultPaths().file, now = Date.now() } = {}) {
  const text = String(entry.text ?? '').trim().slice(0, 500)
  if (!text) return { ok: false, error: '正文为空' }
  const vault = loadVault({ file })
  const id = entry.id || `v_${hashId(text)}`
  const existing = vault.entries.find((e) => e.id === id || String(e.text).trim() === text)
  const base = {
    id,
    kind: ['promise', 'fact', 'preference', 'event'].includes(entry.kind) ? entry.kind : 'fact',
    text,
    keywords: normalizeKeywords(entry.keywords),
    entities: normalizeKeywords(entry.entities),
    importance: Math.max(1, Math.min(5, Number(entry.importance) || 3)),
    status: entry.kind === 'promise' ? 'pending' : 'active',
    dueAt: String(entry.dueAt ?? '').slice(0, 10),
    source: String(entry.source ?? 'manual').slice(0, 40),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    hits: 0,
    lastHitAt: '',
  }
  if (existing) {
    Object.assign(existing, {
      ...base,
      id: existing.id,
      createdAt: existing.createdAt,
      hits: existing.hits,
      lastHitAt: existing.lastHitAt,
      status: existing.status === 'done' ? 'done' : base.status,
    })
    saveVault(vault, { file })
    return { ok: true, entry: existing, updated: true }
  }
  if (!base.keywords.length) base.keywords = extractKeywordsRule(text)
  vault.entries.push(base)
  saveVault(vault, { file })
  return { ok: true, entry: base, updated: false }
}

export function listVault({ status = '', kind = '', limit = 50, file = vaultPaths().file } = {}) {
  const vault = loadVault({ file })
  return vault.entries
    .filter((e) => (!status || e.status === status) && (!kind || e.kind === kind))
    .sort((a, b) => (b.importance - a.importance) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, limit))
}

export function markVaultDone(id, { file = vaultPaths().file, now = Date.now(), done = true } = {}) {
  const vault = loadVault({ file })
  const entry = vault.entries.find((e) => e.id === String(id))
  if (!entry) return { ok: false, error: '没有这条记忆' }
  entry.status = done ? 'done' : (entry.kind === 'promise' ? 'pending' : 'active')
  entry.updatedAt = new Date(now).toISOString()
  saveVault(vault, { file })
  return { ok: true, entry }
}

export function removeVaultEntry(id, { file = vaultPaths().file } = {}) {
  const vault = loadVault({ file })
  const before = vault.entries.length
  vault.entries = vault.entries.filter((e) => e.id !== String(id))
  if (vault.entries.length === before) return { ok: false, error: '没有这条记忆' }
  saveVault(vault, { file })
  return { ok: true }
}

// ── 关键词 ────────────────────────────────────────────────────────────────

const TIME_WORDS = ['今天', '明天', '后天', '周末', '周日', '周六', '下周', '下个月', '月底', '生日', '纪念日', '过年', '假期']
const STOP = new Set(['这个', '那个', '什么', '怎么', '可以', '就是', '然后', '现在', '时候', '东西', '事情', '我们', '你们', '他们', '一下', '有点', '真的', '不是', '没有', '还是'])

/** 规则兜底：时间词 + 引号内容 + 短的、像名词的片段。 */
export function extractKeywordsRule(text) {
  const src = String(text ?? '')
  const out = []
  const add = (k) => { const v = String(k).trim(); if (v && v.length <= 20 && !out.includes(v)) out.push(v) }
  for (const w of TIME_WORDS) if (src.includes(w)) add(w)
  for (const m of src.matchAll(/[「“"『]([^」”"』]{2,12})[」”"』]/g)) add(m[1])
  for (const part of src.split(/[，。！？、；：,.!?;:\s（）()\-—…]+/)) {
    const trimmed = part.replace(/^[我你他她它们这那就都也还又很太真]/, '').trim()
    if (trimmed.length >= 2 && trimmed.length <= 6 && !STOP.has(trimmed) && !out.includes(trimmed)) out.push(trimmed)
    if (out.length >= 6) break
  }
  return out.slice(0, 6)
}

function siliconflowConfig() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const raw = readJson(path.join(home, 'surfcore', 'memory-graph.config.json'), {}) ?? {}
  const sf = raw?.siliconflow && typeof raw.siliconflow === 'object' ? raw.siliconflow : {}
  return {
    apiKey: String(process.env.SILICONFLOW_API_KEY || sf.apiKey || '').trim(),
    baseUrl: String(sf.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, ''),
    chatModel: String(sf.chatModel || 'deepseek-ai/DeepSeek-V3'),
  }
}

/** 用一次小调用抽「以后能在聊天里命中的词」。失败返回 null（调用方退回规则抽取）。 */
export async function extractKeywordsLLM(text, { timeoutMs = 15_000 } = {}) {
  const cfg = siliconflowConfig()
  if (!cfg.apiKey) return null
  const body = {
    model: cfg.chatModel,
    messages: [
      { role: 'system', content: '你是记忆索引器。给你一句记忆，抽 3~6 个以后能用来在聊天里命中它的关键词，以及里面出现的人名/地名/物品/时间等实体。kind 只在明确「答应/约定/承诺」时才用 promise；生日、纪念日、偏好、事实分别用 fact 或 preference。只输出 JSON，不要解释。' },
      { role: 'user', content: `记忆：${String(text).slice(0, 500)}\n\n输出格式：{"keywords":["..."],"entities":["..."],"kind":"promise|fact|preference|event","importance":1-5}` },
    ],
    temperature: 0.2,
    max_tokens: 300,
    response_format: { type: 'json_object' },
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    const parsed = typeof content === 'string' ? JSON.parse(content) : null
    if (!parsed || typeof parsed !== 'object') return null
    return {
      keywords: normalizeKeywords(parsed.keywords),
      entities: normalizeKeywords(parsed.entities),
      kind: ['promise', 'fact', 'preference', 'event'].includes(parsed.kind) ? parsed.kind : '',
      importance: Number(parsed.importance) || 0,
    }
  } catch { return null }
}

/** 写入入口：优先 LLM 抽词，失败退回规则。 */
export async function addFromText(text, { kind = '', importance = 0, source = 'manual', dueAt = '', file = vaultPaths().file, now = Date.now(), useLLM = true } = {}) {
  const content = String(text ?? '').trim()
  if (!content) return { ok: false, error: '正文为空' }
  const llm = useLLM ? await extractKeywordsLLM(content) : null
  const keywords = llm?.keywords?.length ? llm.keywords : extractKeywordsRule(content)
  const entryKind = kind || llm?.kind || (isPromiseText(content) ? 'promise' : 'fact')
  return addVaultEntry({
    kind: entryKind,
    text: content,
    keywords,
    entities: llm?.entities ?? [],
    importance: importance || llm?.importance || (entryKind === 'promise' ? 4 : 3),
    dueAt,
    source,
  }, { file, now })
}

/** 粗判：这句像不像「答应/约定」——只有这类才归成 promise。 */
export function isPromiseText(text) {
  return /答应|说好|讲好|约好|别忘了|一定要|必须|下次|改天|回头|欠你|请你|带你/.test(String(text ?? ''))
}

/** 粗判：这句值不值得进记忆库（承诺 + 生日/纪念日 + 明确让记住的事）。 */
export function isRememberText(text) {
  return isPromiseText(text) || /生日|纪念日|记住|记一下|别忘|我们说/.test(String(text ?? ''))
}

// ── 召回 ──────────────────────────────────────────────────────────────────

function scoreEntry(entry, text) {
  const t = String(text ?? '').toLowerCase()
  if (!t) return 0
  let score = 0
  for (const k of entry.keywords || []) {
    const kk = String(k).toLowerCase()
    if (kk && t.includes(kk)) score += Math.min(6, kk.length)
  }
  for (const e of entry.entities || []) {
    const ee = String(e).toLowerCase()
    if (ee && t.includes(ee)) score += 2
  }
  if (score > 0) score += Math.max(0, Number(entry.importance) || 3) - 3
  return score
}

function renderEntries(entries, { maxChars = 600, now = Date.now() } = {}) {
  const lines = []
  let used = 0
  const kindLabel = { promise: '承诺', fact: '事实', preference: '偏好', event: '事情' }
  for (const e of entries) {
    const label = kindLabel[e.kind] || '事实'
    const info = dueInfo(e, now)
    const due = info.text ? `（${info.text}）` : ''
    const line = `- [${label}] ${String(e.text).slice(0, 90)}${due}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/** 到期信息：今天到期 / 明天到期 / 已过期 N 天 / 具体日期前。按北京时间算「天」。 */
export function dueInfo(entry, now = Date.now()) {
  const raw = String(entry?.dueAt ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { text: '', days: null }
  const due = Date.parse(`${raw}T00:00:00+08:00`)
  if (!Number.isFinite(due)) return { text: '', days: null }
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
  const todayStart = Date.parse(`${today}T00:00:00+08:00`)
  if (!Number.isFinite(todayStart)) return { text: '', days: null }
  const days = Math.round((due - todayStart) / 86_400_000)
  if (days < 0) return { text: `已过期 ${-days} 天`, days }
  if (days === 0) return { text: '今天到期', days }
  if (days === 1) return { text: '明天到期', days }
  return { text: `${raw} 前`, days }
}

/** 列出 N 天内到期/已过期的承诺（CLI 用）。 */
export function listDue({ withinDays = 3, file = vaultPaths().file, now = Date.now() } = {}) {
  const vault = loadVault({ file })
  return vault.entries
    .filter((e) => e.kind === 'promise' && e.status === 'pending')
    .map((e) => ({ entry: e, info: dueInfo(e, now) }))
    .filter((x) => x.info.days !== null && x.info.days <= withinDays)
    .sort((a, b) => a.info.days - b.info.days)
    .map((x) => ({ ...x.entry, dueText: x.info.text, dueDays: x.info.days }))
}

/**
 * 到期提醒：今天到期 / 已经过期的承诺，20 小时最多注入一次。
 * 不管关键词有没有命中都要出现——「答应的事」漏一次就是事故。
 */
export function dueTodayPromptBlock({ limit = 5, maxChars = 400, minGapMs = 20 * 60 * 60 * 1000, ignoreGap = false, touch = true, file = vaultPaths().file, now = Date.now() } = {}) {
  try {
    const vault = loadVault({ file })
    const last = Number(vault.meta?.lastDuePromptAt) || 0
    if (!ignoreGap && last && now - last < minGapMs) return ''
    const due = vault.entries
      .filter((e) => e.kind === 'promise' && e.status === 'pending')
      .map((e) => ({ e, info: dueInfo(e, now) }))
      .filter((x) => x.info.days !== null && x.info.days <= 0)
      .sort((a, b) => a.info.days - b.info.days)
      .slice(0, limit)
    if (!due.length) return ''
    if (touch) { vault.meta = { ...(vault.meta || {}), lastDuePromptAt: now }; saveVault(vault, { file }) }
    return `〔今天必须处理的事（承诺到期）〕\n${renderEntries(due.map((x) => x.e), { maxChars, now })}`
  } catch { return '' }
}

/**
 * 每轮调用：拿当前这句话去匹配，命中才返回（没命中返回 ''，不占 prompt）。
 * 顺带把命中次数记下来，用于以后调权。
 */
export function vaultPromptBlock(text, { maxEntries = 3, maxChars = 600, file = vaultPaths().file, now = Date.now() } = {}) {
  try {
    const vault = loadVault({ file })
    const ranked = vault.entries
      .filter((e) => e.status !== 'done')
      .map((e) => ({ e, score: scoreEntry(e, text) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEntries)
    if (!ranked.length) return ''
    let changed = false
    for (const { e } of ranked) { e.hits = (Number(e.hits) || 0) + 1; e.lastHitAt = new Date(now).toISOString(); changed = true }
    if (changed) saveVault(vault, { file })
    return `〔你记得这些（跟眼前这句话有关，自然会想起来，不用全说）〕\n${renderEntries(ranked.map((x) => x.e), { maxChars })}`
  } catch { return '' }
}

/**
 * 承诺清单：默认 4 小时最多注入一次（ignoreGap=true 时每次都注入，比如 B站 醒来）。
 * 只列 pending 的；过期未兑现的也会列出来（提醒她补救）。
 */
export function promisePromptBlock({ limit = 5, maxChars = 400, minGapMs = DEFAULT_MIN_PROMISE_GAP_MS, ignoreGap = false, touch = true, file = vaultPaths().file, now = Date.now() } = {}) {
  try {
    const vault = loadVault({ file })
    const last = Number(vault.meta?.lastPromisePromptAt) || 0
    if (!ignoreGap && last && now - last < minGapMs) return ''
    const pending = vault.entries
      .filter((e) => e.kind === 'promise' && e.status === 'pending')
      .sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')) || (b.importance - a.importance))
      .slice(0, limit)
    if (!pending.length) return ''
    if (touch) { vault.meta = { ...(vault.meta || {}), lastPromisePromptAt: now }; saveVault(vault, { file }) }
    return `〔还没兑现的事（你自己记着的，别装作忘了）〕\n${renderEntries(pending, { maxChars })}`
  } catch { return '' }
}

// ── 自动捕获队列（工具/桥接写，插件进程抽词入库）──────────────────────────

export function pushVaultCandidate(text, { source = 'qq', file = vaultPaths().inbox } = {}) {
  try {
    const content = String(text ?? '').trim()
    if (content.length < 4) return { ok: false, reason: 'too-short' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), source, text: content.slice(0, 500) })}\n`, 'utf8')
    return { ok: true }
  } catch (error) { return { ok: false, reason: String(error?.message ?? error) } }
}

export function takeVaultCandidates({ file = vaultPaths().inbox } = {}) {
  try {
    if (!fs.existsSync(file)) return { ok: true, items: [], moved: '' }
    const moved = `${file}.processing`
    try { fs.unlinkSync(moved) } catch {}
    fs.renameSync(file, moved)
    const items = []
    for (const line of fs.readFileSync(moved, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { items.push(JSON.parse(line)) } catch {}
    }
    return { ok: true, items, moved }
  } catch (error) { return { ok: false, items: [], moved: '', reason: String(error?.message ?? error) } }
}

export function commitVaultCandidates(moved) {
  try { if (moved) fs.unlinkSync(moved); return { ok: true } } catch { return { ok: false } }
}

export function rollbackVaultCandidates(moved, { file = vaultPaths().inbox } = {}) {
  try {
    if (!moved || !fs.existsSync(moved)) return { ok: false }
    fs.appendFileSync(file, fs.readFileSync(moved, 'utf8'), 'utf8')
    fs.unlinkSync(moved)
    return { ok: true }
  } catch { return { ok: false } }
}
