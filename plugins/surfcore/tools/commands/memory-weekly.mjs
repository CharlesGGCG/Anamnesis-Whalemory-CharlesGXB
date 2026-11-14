// 每周记忆摘要：把最近 N 天的碎记录压成 4~6 条「值得记住的事」，写进周记 + 外置记忆库。
//
//   node memory-weekly.mjs [--days 7] [--dry] [--no-llm] [--scan]
//
//   --dry     只看会写什么，不落盘
//   --no-llm  不调模型（按重要度/情绪挑原始片段，不做概括）
//   --scan    只体检：统计记忆里有多少手机号/证件号/链接/密钥形状的文本（不修改）
//
// 产物：
//   <memory>/memory-weekly.md   追加一节「## YYYY-MM-DD 周记」
//   vault.json                  一条 kind=event、source=weekly 的记忆（可被关键词召回）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { vaultPaths, addFromText } from '../../../../src/memory-vault.js'
import { redactForMemory } from '../../../../src/memory-card.js'

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const days = Math.max(1, Math.min(60, Number(args.get('days')) || 7))
const dry = args.has('dry')
const noLlm = args.has('no-llm')
const scanOnly = args.has('scan')

const dir = vaultPaths().dir
const cardFile = path.join(dir, 'memory-card.json')
if (!fs.existsSync(cardFile)) { console.error(`读不到记忆卡：${cardFile}`); process.exit(3) }
const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'))
const now = Date.now()
const since = now - days * 86_400_000
const records = (card.records || [])
  .filter((r) => String(r.text || '').trim())
  .filter((r) => {
    const t = Date.parse(String(r.createdAt || '')) || 0
    return t >= since
  })

if (scanOnly) {
  const patterns = [
    ['手机号', /\b1[3-9]\d{9}\b/g],
    ['证件/卡号', /\b\d{15,19}\b/g],
    ['链接', /https?:\/\//g],
    ['密钥形状', /\b(?:sk|ghp|xoxb)[-_][A-Za-z0-9_-]{8,}\b/g],
    ['密码/令牌字样', /(密码|口令|密钥|令牌|验证码)\s*(是|为|[:=：])/g],
  ]
  console.log(`体检范围：最近 ${days} 天，${records.length} 条`)
  for (const [name, re] of patterns) {
    let hits = 0
    for (const r of records) hits += (String(r.text).match(re) || []).length
    console.log(`  ${name}: ${hits}`)
  }
  process.exit(0)
}

if (!records.length) { console.log(`最近 ${days} 天没有新记录，跳过`); process.exit(0) }

function cfg() {
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

async function summarize(items) {
  const c = cfg()
  if (!c.apiKey) return null
  const lines = items.slice(0, 80).map((r) => `- ${String(r.text).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
  const body = {
    model: c.model,
    messages: [
      { role: 'system', content: '你在整理一段长期陪伴的记忆。把下面最近的记录压成 4~6 条「值得长期记住的事」：只保留人物关系、承诺/约定、情绪节点、偏好变化、重要事件；不要流水账，不要杜撰，不要号码/地址/链接。只输出 JSON：{"bullets":["..."]}' },
      { role: 'user', content: `最近 ${days} 天，共 ${items.length} 条记录：\n${lines}` },
    ],
    temperature: 0.3,
    max_tokens: 800,
    response_format: { type: 'json_object' },
  }
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    const parsed = typeof content === 'string' ? JSON.parse(content) : null
    const bullets = Array.isArray(parsed?.bullets) ? parsed.bullets : []
    return bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 8)
  } catch { return null }
}

function fallbackBullets(items) {
  const scored = items
    .map((r) => ({ r, score: (Number(r.importance) || 0) + (Number(r.emotional) || 0) * 2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
  return scored.map((x) => `（${String(x.r.createdAt).slice(0, 10)}）${String(x.r.text).replace(/\s+/g, ' ').slice(0, 80)}`)
}

const llmBullets = noLlm ? null : await summarize(records)
const bullets = (llmBullets?.length ? llmBullets : fallbackBullets(records))
  .map((b) => redactForMemory(b, { scope: 'qq', maxChars: 200 }))
  .filter(Boolean)

const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
const mdFile = path.join(dir, 'memory-weekly.md')
const section = `\n## ${today} 周记（最近 ${days} 天，${records.length} 条）\n${bullets.map((b) => `- ${b}`).join('\n')}\n`

console.log(`最近 ${days} 天：${records.length} 条记录，摘要 ${bullets.length} 条${llmBullets?.length ? '（LLM）' : '（规则兜底）'}`)
for (const b of bullets) console.log(`  - ${b}`)

if (dry) { console.log('（dry-run，未写入）'); process.exit(0) }

fs.appendFileSync(mdFile, section, 'utf8')
const vaultText = `第 ${Math.ceil(days / 7)} 周小结：${bullets.join('；')}`.slice(0, 480)
const added = await addFromText(vaultText, { kind: 'event', importance: 3, source: 'weekly', useLLM: !noLlm })
console.log(`已写 ${mdFile}`)
console.log(added.ok ? `已加入记忆库：${added.entry.id}` : `记忆库写入失败：${added.error}`)
