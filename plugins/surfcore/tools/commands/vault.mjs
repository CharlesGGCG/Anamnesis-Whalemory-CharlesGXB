// 外置记忆库 CLI。
//
//   node vault.mjs add --text "答应周末陪主人去江边散步" [--kind promise] [--importance 4] [--due 2026-11-16] [--no-llm]
//   node vault.mjs list [--status pending] [--kind promise] [--limit 20]
//   node vault.mjs search "散步"
//   node vault.mjs done <id>
//   node vault.mjs rm <id>
//   node vault.mjs import-card [--min-importance 65] [--llm] [--dry]
//
// 关键词默认用 SiliconFlow 抽（memory-graph.config.json 的 key）；--no-llm 或失败时退回规则抽取。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  addFromText, listVault, markVaultDone, removeVaultEntry, vaultPaths, vaultPromptBlock, dueInfo, listDue,
} from '../../../../src/memory-vault.js'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'list'
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const flag = (name) => args.get(name) === true || args.has(name)

function printEntry(e) {
  const info = e.dueAt ? dueInfo(e) : { text: '' }
  const due = e.dueAt ? `  截止 ${e.dueAt}${info.text ? `（${info.text}）` : ''}` : ''
  const hit = e.hits ? `  命中 ${e.hits} 次` : ''
  console.log(`${e.id}  [${e.kind}/${e.status}]  ★${e.importance}${due}${hit}`)
  console.log(`  ${String(e.text).slice(0, 200)}`)
  console.log(`  关键词：${(e.keywords || []).join('、') || '（无）'}`)
}

if (cmd === 'add') {
  const text = String(args.get('text') ?? '').trim()
  if (!text) { console.error('需要 --text'); process.exit(2) }
  const r = await addFromText(text, {
    kind: String(args.get('kind') ?? ''),
    importance: Number(args.get('importance')) || 0,
    dueAt: String(args.get('due') ?? ''),
    repeat: String(args.get('repeat') ?? ''),
    source: 'cli',
    useLLM: !flag('no-llm'),
  })
  if (!r.ok) { console.error(`失败：${r.error}`); process.exit(3) }
  console.log(r.updated ? '已更新同一条记忆：' : '已加入：')
  printEntry(r.entry)
  process.exit(0)
}

if (cmd === 'list') {
  const rows = listVault({
    status: String(args.get('status') ?? ''),
    kind: String(args.get('kind') ?? ''),
    limit: Number(args.get('limit')) || 50,
  })
  if (!rows.length) { console.log('（记忆库是空的）'); process.exit(0) }
  for (const e of rows) printEntry(e)
  process.exit(0)
}

if (cmd === 'search') {
  const text = String(argv.slice(1).filter((a) => !a.startsWith('--')).join(' ') || args.get('text') || '').trim()
  if (!text) { console.error('需要要匹配的文本'); process.exit(2) }
  const block = vaultPromptBlock(text)
  console.log(block || '（没有命中）')
  process.exit(0)
}

if (cmd === 'due') {
  const within = Number(args.get('days')) || 3
  const rows = listDue({ withinDays: within })
  if (!rows.length) { console.log(`（${within} 天内没有到期/过期的承诺）`); process.exit(0) }
  for (const e of rows) printEntry(e)
  process.exit(0)
}

if (cmd === 'done' || cmd === 'rm') {
  const id = String(argv[1] ?? '')
  if (!id) { console.error('需要 id'); process.exit(2) }
  const r = cmd === 'done' ? markVaultDone(id) : removeVaultEntry(id)
  console.log(r.ok ? `已${cmd === 'done' ? '标记兑现' : '删除'}：${id}` : `失败：${r.error}`)
  process.exit(r.ok ? 0 : 3)
}

if (cmd === 'import-card') {
  const minImp = Number(args.get('min-importance')) || 65
  const dry = flag('dry')
  const { dir, file: vaultFile } = vaultPaths()
  const json = path.join(dir, 'memory-card.json')
  let card
  try { card = JSON.parse(fs.readFileSync(json, 'utf8')) } catch { console.error(`读不到记忆卡：${json}`); process.exit(3) }
  const recs = (card.records || []).filter((r) => (r.tags || []).includes('owner') && Number(r.importance) >= minImp)
  console.log(`记忆卡里 importance ≥ ${minImp} 的主人记录：${recs.length} 条${dry ? '（dry-run）' : ''}`)
  let added = 0
  for (const r of recs) {
    const text = String(r.text ?? '').trim()
    if (!text) continue
    if (dry) { console.log('  +', text.slice(0, 60)); continue }
    const out = await addFromText(text, {
      kind: flag('llm') ? '' : (r.kind === 'promise' ? 'promise' : 'fact'),
      importance: Math.min(5, Math.max(1, Math.round(Number(r.importance) / 20))),
      source: 'card-import',
      useLLM: flag('llm'),
    })
    if (out.ok) added += 1
  }
  console.log(dry ? '（未写入）' : `已导入 ${added} 条到 ${vaultFile}`)
  process.exit(0)
}

console.error('用法：add | list | due [--days 3] | search | done <id> | rm <id> | import-card')
process.exit(2)
