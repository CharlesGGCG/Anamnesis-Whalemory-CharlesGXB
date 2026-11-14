// 外置记忆库：命中、承诺清单、去重、入库队列。
// 跑法：node scripts/test-memory-vault.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addFromText, addVaultEntry, listVault, markVaultDone, vaultPromptBlock, promisePromptBlock,
  extractKeywordsRule, isPromiseText, loadVault, dueInfo, listDue, dueTodayPromptBlock, upcomingPromptBlock,
  pushVaultCandidate, takeVaultCandidates, commitVaultCandidates, rollbackVaultCandidates,
} from '../src/memory-vault.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'))
const file = path.join(dir, 'vault.json')
const inbox = path.join(dir, 'vault-inbox.jsonl')
const T0 = Date.parse('2026-11-14T12:00:00Z')

// 1) 写入（规则抽词，避免联网）：承诺句自动识别成 promise
const a = await addFromText('答应周末陪主人去江边散步，如果下雨就改到周日', { file, now: T0, useLLM: false })
assert.equal(a.ok, true)
assert.equal(a.entry.kind, 'promise')
assert.ok(a.entry.keywords.includes('周末') || a.entry.keywords.includes('散步'))
assert.equal(a.entry.status, 'pending')

// 2) 事实条目
const b = await addFromText('主人的生日是 11 月 20 日', { file, now: T0, useLLM: false })
assert.equal(b.ok, true)
assert.equal(b.entry.kind === 'promise', false)

// 3) 命中：相关句子召回，不相关不召回
const hit = vaultPromptBlock('周末还去散步吗', { file, now: T0 })
assert.match(hit, /你记得这些/)
assert.match(hit, /散步|周末/)
assert.equal(vaultPromptBlock('今天风有点大', { file, now: T0 }), '')
assert.equal(loadVault({ file }).entries.find((e) => e.id === a.entry.id).hits, 1)

// 4) 去重：同文再写一次 = 更新，不新增
const again = await addFromText('答应周末陪主人去江边散步，如果下雨就改到周日', { file, now: T0, useLLM: false })
assert.equal(again.updated, true)
assert.equal(loadVault({ file }).entries.length, 2)

// 5) 承诺清单：4 小时只注入一次；ignoreGap 每次都注入
const p1 = promisePromptBlock({ file, now: T0 })
assert.match(p1, /还没兑现的事/)
assert.match(p1, /散步/)
assert.equal(promisePromptBlock({ file, now: T0 + 60 * 60 * 1000 }), '')
assert.match(promisePromptBlock({ file, now: T0 + 60 * 60 * 1000, ignoreGap: true }), /散步/)
assert.match(promisePromptBlock({ file, now: T0 + 5 * 60 * 60 * 1000 }), /散步/)

// 6) 标记兑现后不再出现
markVaultDone(a.entry.id, { file })
assert.equal(promisePromptBlock({ file, now: T0 + 10 * 60 * 60 * 1000 }), '')

// 7) 列表 / 规则抽词 / 承诺判定
assert.ok(listVault({ file, limit: 10 }).length >= 2)
assert.ok(extractKeywordsRule('「江边」明天见').includes('江边'))
assert.equal(isPromiseText('晚上吃什么'), false)
assert.equal(isPromiseText('我答应你明天一定去'), true)

// 8) 自动捕获队列：写 → 取 → 提交；失败回滚
pushVaultCandidate('别忘了 11 月 20 日是主人的生日', { file: inbox })
pushVaultCandidate('答应下周末一起看电影', { file: inbox })
const taken = takeVaultCandidates({ file: inbox })
assert.equal(taken.items.length, 2)
assert.equal(fs.existsSync(inbox), false)
assert.equal(commitVaultCandidates(taken.moved).ok, true)

pushVaultCandidate('这条要回滚', { file: inbox })
const taken2 = takeVaultCandidates({ file: inbox })
const rolled = rollbackVaultCandidates(taken2.moved, { file: inbox })
assert.equal(rolled.ok, true)
assert.equal(takeVaultCandidates({ file: inbox }).items.length, 1)

// 9) 空/坏文件不炸
assert.deepEqual(takeVaultCandidates({ file: path.join(dir, 'nope.jsonl') }).items, [])
assert.equal(loadVault({ file: path.join(dir, 'nope.json') }).entries.length, 0)

// 10) 承诺到期：dueInfo 按北京时间算天；dueTodayPromptBlock 只列今天/过期；20h 冷却
const dueFile = path.join(dir, 'due.json')
const T1 = Date.parse('2026-11-14T12:00:00Z') // 北京时间 2026-11-14 20:00
addVaultEntry({ kind: 'promise', text: '今天要交的作业', dueAt: '2026-11-14' }, { file: dueFile, now: T1 })
addVaultEntry({ kind: 'promise', text: '前天就该做的事', dueAt: '2026-11-12' }, { file: dueFile, now: T1 })
addVaultEntry({ kind: 'promise', text: '下周才到期的事', dueAt: '2026-11-20' }, { file: dueFile, now: T1 })
addVaultEntry({ kind: 'fact', text: '生日是 11 月 20 日', dueAt: '2026-11-14' }, { file: dueFile, now: T1 })
assert.equal(dueInfo({ dueAt: '2026-11-14' }, T1).text, '今天到期')
assert.equal(dueInfo({ dueAt: '2026-11-12' }, T1).text, '已过期 2 天')
assert.equal(dueInfo({ dueAt: '2026-11-15' }, T1).text, '明天到期')
assert.equal(dueInfo({ dueAt: '2026-11-20' }, T1).days, 6)
assert.equal(dueInfo({ dueAt: '' }, T1).days, null)

const dueRows = listDue({ withinDays: 3, file: dueFile, now: T1 })
assert.equal(dueRows.length, 2, '只列今天/过期，不列下周和 fact')

const d1 = dueTodayPromptBlock({ file: dueFile, now: T1 })
assert.match(d1, /今天必须处理的事/)
assert.match(d1, /今天要交的作业/)
assert.match(d1, /前天就该做的事/)
assert.equal(dueTodayPromptBlock({ file: dueFile, now: T1 + 3600_000 }), '', '20 小时内不重复')
assert.match(dueTodayPromptBlock({ file: dueFile, now: T1 + 21 * 3600_000 }), /今天要交的作业/)

// 11) 年度重复：生日不会变成「过期」，7 天内提醒、20h 冷却
const bdayFile = path.join(dir, 'bday.json')
addVaultEntry({ kind: 'fact', text: '主人的生日是 2006 年 12 月 2 日', dueAt: '2006-12-02', repeat: 'yearly' }, { file: bdayFile, now: T1 })
assert.equal(dueInfo({ dueAt: '2006-12-02', repeat: 'yearly' }, T1).days, 18)
assert.equal(dueInfo({ dueAt: '2006-12-02', repeat: 'yearly' }, Date.parse('2026-12-02T04:00:00Z')).text, '就是今天')
assert.equal(upcomingPromptBlock({ withinDays: 7, file: bdayFile, now: Date.parse('2026-11-20T12:00:00Z') }), '', '12 天前不提醒')
const soonAt = Date.parse('2026-11-28T12:00:00Z')
assert.match(upcomingPromptBlock({ withinDays: 7, file: bdayFile, now: soonAt }), /快到了的日子/)
assert.match(upcomingPromptBlock({ withinDays: 7, file: bdayFile, now: soonAt + 21 * 3600_000 }), /生日/)
assert.match(promisePromptBlock({ file: bdayFile, now: T1 }), /^$/, '生日不是承诺，不进承诺清单')

fs.rmSync(dir, { recursive: true, force: true })
console.log('ok memory-vault: 写入/命中/承诺/去重/队列/到期/年度 11 组断言通过')
