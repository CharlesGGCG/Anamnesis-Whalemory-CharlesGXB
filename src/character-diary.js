// 角色日记（共享逻辑）：写 / 读 / 从她自己的记忆与聊天历史生成。
//
// 存放：characters/<id>/diary/YYYY-MM-DD.md（北京时间；每条 "## HH:mm"）
// 数据源只读该角色自己的：记忆卡 + pet/chat/history-<id>*.json。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { memoryPathsFor, readCurrentCharacter } from './character-persona.js'
import { redactForMemory } from './memory-card.js'

export function diaryDir(characterId = '') {
  const id = String(characterId || '').trim() || readCurrentCharacter()?.id || ''
  return path.join(path.dirname(memoryPathsFor(id).dir), 'diary')
}

export function diaryDate(now = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
}

export function diaryFile(characterId = '', date = diaryDate()) {
  return path.join(diaryDir(characterId), `${date}.md`)
}

export function appendDiary({ characterId = '', text = '', mood = '', now = Date.now() } = {}) {
  const body = redactForMemory(String(text || '').trim(), { scope: 'qq', maxChars: 1200 })
  if (!body) return { ok: false, error: '正文为空' }
  const dir = diaryDir(characterId)
  fs.mkdirSync(dir, { recursive: true })
  const date = diaryDate(now)
  const f = diaryFile(characterId, date)
  const hm = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now))
  const head = fs.existsSync(f) ? '' : `# ${date} 日记\n`
  const moodLine = mood ? `（心情：${mood}）\n\n` : '\n'
  fs.appendFileSync(f, `${head}\n## ${hm}\n${moodLine}${body}\n`, 'utf8')
  return { ok: true, file: f, date, body }
}

export function hasDiaryToday(characterId = '', now = Date.now()) {
  try { return fs.existsSync(diaryFile(characterId, diaryDate(now))) } catch { return false }
}

export function listDiary({ characterId = '', limit = 10 } = {}) {
  const dir = diaryDir(characterId)
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(-Math.max(1, limit))
  } catch { return [] }
}

/** 收集最近 N 天素材（只读该角色自己的记忆卡 + 聊天历史）。 */
export function diaryMaterial({ characterId = '', days = 1, now = Date.now() } = {}) {
  const since = now - days * 86_400_000
  const toMs = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    const s = String(v ?? '')
    if (/^\d{10,}$/.test(s)) return Number(s)
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : 0
  }
  const items = []
  try {
    const card = JSON.parse(fs.readFileSync(memoryPathsFor(characterId).json, 'utf8'))
    for (const r of card.records || []) {
      if (toMs(r.createdAt) < since) continue
      const text = String(r.text || '').trim()
      if (text) items.push(`[${String(r.createdAt).slice(0, 10)}] ${text.slice(0, 160)}`)
    }
  } catch {}
  try {
    const id = String(characterId || '').trim() || readCurrentCharacter()?.id || ''
    const chatDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'surfcore', 'pet', 'chat')
    for (const f of fs.readdirSync(chatDir).filter((x) => id && x.startsWith(`history-${id}`) && x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(chatDir, f), 'utf8'))
      for (const m of j.messages || []) {
        if (toMs(m.at ?? m.createdAt) < since) continue
        const text = String(m.text || '').trim()
        if (text) items.push(`${m.role === 'assistant' ? '我' : '对方'}：${text.slice(0, 160)}`)
      }
    }
  } catch {}
  return items
}

function llmConfig() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'surfcore', 'memory-graph.config.json'), 'utf8'))
    const sf = raw?.siliconflow || {}
    return {
      apiKey: String(process.env.SILICONFLOW_API_KEY || sf.apiKey || '').trim(),
      baseUrl: String(sf.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, ''),
      model: String(sf.chatModel || 'deepseek-ai/DeepSeek-V3'),
    }
  } catch { return { apiKey: '', baseUrl: '', model: '' } }
}

/** 用 LLM 把素材写成第一人称日记（3~5 句 + 心情词）。 */
export async function collectDiary({ characterId = '', days = 1, now = Date.now() } = {}) {
  const items = diaryMaterial({ characterId, days, now })
  if (!items.length) return { ok: false, reason: `最近 ${days} 天没有素材`, items }
  const c = llmConfig()
  if (!c.apiKey) return { ok: false, reason: '缺 SiliconFlow key', items }
  const body = {
    model: c.model,
    messages: [
      { role: 'system', content: '你在替一个角色写她自己的私人日记。用第一人称、口语、3~5 句话，写她今天/最近在意的事、情绪、和对方的关系变化；不要流水账，不要编造没发生的事，不要提 AI/模型/系统/记忆，不要号码/链接。只输出 JSON：{"diary":"...","mood":"一个词"}' },
      { role: 'user', content: `角色：${characterId || '当前角色'}\n最近的素材：\n${items.slice(0, 80).join('\n')}` },
    ],
    temperature: 0.6,
    max_tokens: 500,
    response_format: { type: 'json_object' },
  }
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return { ok: false, reason: `LLM HTTP ${res.status}`, items }
    const data = await res.json()
    const parsed = JSON.parse(String(data?.choices?.[0]?.message?.content || '{}'))
    const diary = redactForMemory(String(parsed.diary || '').trim(), { scope: 'qq', maxChars: 1200 })
    if (!diary) return { ok: false, reason: 'LLM 返回空日记', items }
    return { ok: true, diary, mood: String(parsed.mood || '').slice(0, 12), items }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), items }
  }
}
