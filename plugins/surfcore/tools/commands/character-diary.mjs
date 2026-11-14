// 小C 的日记（按角色）。
//
//   node character-diary.mjs write --text "今天…" [--character claude] [--mood 平静] [--dry]
//   node character-diary.mjs collect [--character claude] [--days 3] [--dry]
//   node character-diary.mjs list [--character claude] [--limit 10]
//
// 存放：characters/<id>/diary/YYYY-MM-DD.md（北京时间；每条一个 "## HH:mm" 小节）
// collect：读该角色的记忆卡 + 聊天历史（pet/chat/history-*.json）最近 N 天，用 LLM 写成第一人称日记。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { memoryPathsFor, readCurrentCharacter } from '../../../../src/character-persona.js'
import { redactForMemory } from '../../../../src/memory-card.js'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'list'
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const characterId = String(args.get('character') ?? '').trim() || readCurrentCharacter()?.id || ''
const dry = args.has('dry')
const dir = path.join(path.dirname(memoryPathsFor(characterId).dir), 'diary')

function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
}
function nowHM() {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
}
function fileFor(date = today()) {
  return path.join(dir, `${date}.md`)
}
function append(date, text, mood = '') {
  fs.mkdirSync(dir, { recursive: true })
  const f = fileFor(date)
  const exists = fs.existsSync(f)
  const head = exists ? '' : `# ${date} 日记\n`
  const moodLine = mood ? `（心情：${mood}）\n\n` : '\n'
  fs.appendFileSync(f, `${head}\n## ${nowHM()}\n${moodLine}${text.trim()}\n`, 'utf8')
  return f
}
function cfg() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'surfcore', 'memory-graph.config.json'), 'utf8'))
    const sf = raw?.siliconflow || {}
    return { apiKey: String(process.env.SILICONFLOW_API_KEY || sf.apiKey || '').trim(), baseUrl: String(sf.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, ''), model: String(sf.chatModel || 'deepseek-ai/DeepSeek-V3') }
  } catch { return { apiKey: '', baseUrl: '', model: '' } }
}

const toMs = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const s = String(v ?? '')
  if (/^\d{10,}$/.test(s)) return Number(s)
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

async function collect({ days = 3 } = {}) {
  const since = Date.now() - days * 86_400_000
  const items = []
  // 1) 记忆卡里她的记录
  try {
    const cardFile = memoryPathsFor(characterId).json
    const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'))
    for (const r of card.records || []) {
      if (toMs(r.createdAt) < since) continue
      const text = String(r.text || '').trim()
      if (text) items.push(`[${String(r.createdAt).slice(0, 10)}] ${text.slice(0, 160)}`)
    }
  } catch {}
  // 2) 聊天历史（她自己说的话 + 对方说的）
  try {
    const chatDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'surfcore', 'pet', 'chat')
    const files = fs.readdirSync(chatDir).filter((f) => f.startsWith(`history-${characterId}`) && f.endsWith('.json'))
    for (const f of files) {
      const j = JSON.parse(fs.readFileSync(path.join(chatDir, f), 'utf8'))
      for (const m of j.messages || []) {
        if (toMs(m.at ?? m.createdAt) < since) continue
        const who = m.role === 'assistant' ? '我' : '对方'
        const text = String(m.text || '').trim()
        if (text) items.push(`${who}：${text.slice(0, 160)}`)
      }
    }
  } catch {}
  if (!items.length) return { ok: false, reason: `最近 ${days} 天没有素材` }
  const c = cfg()
  if (!c.apiKey) return { ok: false, reason: '缺 SiliconFlow key，无法生成日记', items }
  const body = {
    model: c.model,
    messages: [
      { role: 'system', content: '你在替一个角色写她自己的私人日记。用第一人称、口语、3~5 句话，写她今天/最近在意的事、情绪、和对方的关系变化；不要流水账，不要编造没发生的事，不要提 AI/模型/系统，不要号码/链接。只输出 JSON：{"diary":"...","mood":"一个词"}' },
      { role: 'user', content: `角色：${characterId}\n最近的素材：\n${items.slice(0, 80).join('\n')}` },
    ],
    temperature: 0.6,
    max_tokens: 500,
    response_format: { type: 'json_object' },
  }
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    if (!res.ok) return { ok: false, reason: `LLM HTTP ${res.status}`, items }
    const data = await res.json()
    const parsed = JSON.parse(String(data?.choices?.[0]?.message?.content || '{}'))
    const diary = redactForMemory(String(parsed.diary || '').trim(), { scope: 'qq', maxChars: 1200 })
    if (!diary) return { ok: false, reason: 'LLM 返回空日记', items }
    return { ok: true, diary, mood: String(parsed.mood || '').slice(0, 12), items }
  } catch (error) { return { ok: false, reason: String(error?.message ?? error), items } }
}

if (cmd === 'write') {
  const text = String(args.get('text') ?? '').trim()
  if (!text) { console.error('需要 --text'); process.exit(2) }
  const body = redactForMemory(text, { scope: 'qq', maxChars: 1200 })
  if (dry) { console.log(`[dry] ${fileFor()}\n${body}`); process.exit(0) }
  console.log('已写：', append(today(), body, String(args.get('mood') ?? '')))
  process.exit(0)
}

if (cmd === 'collect') {
  const r = await collect({ days: Number(args.get('days')) || 3 })
  if (!r.ok) { console.log(`没有生成：${r.reason}${r.items ? `（素材 ${r.items.length} 条）` : ''}`); process.exit(0) }
  console.log(`素材 ${r.items.length} 条 → 日记：\n${r.diary}\n（心情：${r.mood || '—'}）`)
  if (dry) { console.log('（dry-run，未写入）'); process.exit(0) }
  console.log('已写：', append(today(), r.diary, r.mood))
  process.exit(0)
}

if (cmd === 'list') {
  fs.mkdirSync(dir, { recursive: true })
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-(Number(args.get('limit')) || 10))
  if (!files.length) { console.log(`（${dir} 还是空的）`); process.exit(0) }
  for (const f of files) console.log(`- ${f}  ${fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length} 行`)
  process.exit(0)
}

console.error('用法：write --text | collect [--days 3] | list')
process.exit(2)
