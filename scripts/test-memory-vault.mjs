// 外置记忆库：命中、承诺清单、去重、入库队列。
// 跑法：node scripts/test-memory-vault.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addFromText, addVaultEntry, listVault, markVaultDone, vaultPromptBlock, promisePromptBlock,
  extractKeywordsRule, isPromiseText, loadVault,
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

fs.rmSync(dir, { recursive: true, force: true })
console.log('ok memory-vault: 写入/命中/承诺/去重/队列 9 组断言通过')
