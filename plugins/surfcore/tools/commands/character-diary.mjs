// 小C 的日记（按角色）。
//
//   node character-diary.mjs write --text "今天…" [--character claude] [--mood 平静] [--dry]
//   node character-diary.mjs collect [--character claude] [--days 3] [--dry]
//   node character-diary.mjs list [--character claude] [--limit 10]
//
// 存放：characters/<id>/diary/YYYY-MM-DD.md（北京时间；每条一个 "## HH:mm" 小节）
// collect：读该角色自己的记忆卡 + 聊天历史，用 LLM 写成第一人称日记。
import fs from 'node:fs'
import path from 'node:path'
import { readCurrentCharacter } from '../../../../src/character-persona.js'
import { appendDiary, collectDiary, diaryDir, diaryFile, hasDiaryToday, listDiary } from '../../../../src/character-diary.js'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'list'
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const characterId = String(args.get('character') ?? '').trim() || readCurrentCharacter()?.id || ''
const dry = args.has('dry')

if (cmd === 'write') {
  const text = String(args.get('text') ?? '').trim()
  if (!text) { console.error('需要 --text'); process.exit(2) }
  if (dry) { console.log(`[dry] ${diaryFile(characterId)}\n${text}`); process.exit(0) }
  const r = appendDiary({ characterId, text, mood: String(args.get('mood') ?? '') })
  console.log(r.ok ? `已写：${r.file}` : `失败：${r.error}`)
  process.exit(r.ok ? 0 : 3)
}

if (cmd === 'collect') {
  const days = Number(args.get('days')) || 3
  const r = await collectDiary({ characterId, days })
  if (!r.ok) { console.log(`没有生成：${r.reason}${r.items ? `（素材 ${r.items.length} 条）` : ''}`); process.exit(0) }
  console.log(`素材 ${r.items.length} 条 → 日记：\n${r.diary}\n（心情：${r.mood || '—'}）`)
  if (dry) { console.log('（dry-run，未写入）'); process.exit(0) }
  if (hasDiaryToday(characterId)) console.log('注意：今天已经有一篇，这篇会追加到同一天。')
  const w = appendDiary({ characterId, text: r.diary, mood: r.mood })
  console.log(w.ok ? `已写：${w.file}` : `写入失败：${w.error}`)
  process.exit(w.ok ? 0 : 3)
}

if (cmd === 'list') {
  const files = listDiary({ characterId, limit: Number(args.get('limit')) || 10 })
  if (!files.length) { console.log(`（${diaryDir(characterId)} 还是空的）`); process.exit(0) }
  for (const f of files) console.log(`- ${f}  ${fs.readFileSync(path.join(diaryDir(characterId), f), 'utf8').split('\n').length} 行`)
  process.exit(0)
}

console.error('用法：write --text | collect [--days 3] | list')
process.exit(2)
