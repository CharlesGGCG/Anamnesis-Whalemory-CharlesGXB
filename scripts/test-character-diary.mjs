// 角色日记：写/读/按角色隔离（不调 LLM）。
// 跑法：node scripts/test-character-diary.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { appendDiary, diaryDate, diaryDir, diaryFile, hasDiaryToday, listDiary, collectDiary, diaryMaterial } from '../src/character-diary.js'

const id = 'test-diary-xyz'
const dir = diaryDir(id)
try {
  // 1) 写第一篇
  const a = appendDiary({ characterId: id, text: '今天测试了一件小事。', mood: '平静' })
  assert.equal(a.ok, true)
  assert.equal(a.file, diaryFile(id))
  assert.ok(a.file.includes(path.join('characters', id, 'diary')))
  assert.equal(hasDiaryToday(id), true)

  // 2) 同一天再写 → 追加，不覆盖
  const b = appendDiary({ characterId: id, text: '第二段。' })
  assert.equal(b.ok, true)
  const text = fs.readFileSync(a.file, 'utf8')
  assert.equal((text.match(/^## /gm) || []).length, 2)
  assert.match(text, /今天测试了一件小事/)
  assert.match(text, /（心情：平静）/)

  // 3) 列表
  assert.deepEqual(listDiary({ characterId: id, limit: 5 }), [path.basename(a.file)])

  // 4) 文件按北京时间日期命名
  assert.equal(path.basename(a.file), `${diaryDate()}.md`)

  // 5) 没有素材的角色：collect 直接拒绝（不会调 LLM）
  assert.deepEqual(diaryMaterial({ characterId: id, days: 1 }), [])
  const c = await collectDiary({ characterId: id, days: 1 })
  assert.equal(c.ok, false)
  assert.match(c.reason, /没有素材/)

  // 6) 空正文拒绝
  assert.equal(appendDiary({ characterId: id, text: '   ' }).ok, false)

  console.log('ok character-diary: 写/追加/列表/隔离/空正文 6 组断言通过')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
  const charRoot = path.dirname(dir)
  try { if (fs.readdirSync(charRoot).length === 0) fs.rmdirSync(charRoot) } catch {}
}
