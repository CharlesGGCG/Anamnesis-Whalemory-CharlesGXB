// 记忆图谱出站队列：短进程写、插件进程取。
// 跑法：node scripts/test-graph-outbox.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  pushGraphEvent,
  readGraphEvents,
  takeGraphEvents,
  commitGraphEvents,
  rollbackGraphEvents,
  turnForGraphEvent,
} from '../plugins/surfcore/tools/lib/graph-outbox.mjs'
import { createGraphOutboxDrain } from '../plugins/surfcore/lib/graph-outbox.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-outbox-'))
const file = path.join(dir, 'graph-outbox.jsonl')

// 1) 追加两条（一条看视频、一条评论）
const a = pushGraphEvent({ kind: 'bili-watch', bvid: 'BV1St4Y6jEkc', title: '测试视频', up: '某UP', tname: '科技', mode: 'full' }, { file })
assert.equal(a.ok, true)
const b = pushGraphEvent({ kind: 'bili-comment', bvid: 'BV1St4Y6jEkc', text: '这条鱼好可爱' }, { file })
assert.equal(b.ok, true)
assert.equal(readGraphEvents({ file }).length, 2)

// 2) 缺 kind 的拒绝
assert.equal(pushGraphEvent({ title: 'x' }, { file }).ok, false)

// 3) take：原子搬走，原文件消失，出现 .processing
const taken = takeGraphEvents({ file })
assert.equal(taken.ok, true)
assert.equal(taken.events.length, 2)
assert.equal(fs.existsSync(file), false)
assert.equal(fs.existsSync(taken.moved), true)

// 4) 事件 → 一问一答（归属：事件写在她的那一侧，userMessage 只是系统标记）
const t1 = turnForGraphEvent(taken.events[0])
assert.match(t1.aiResponse, /看了视频《测试视频》/)
assert.match(t1.aiResponse, /UP主 某UP/)
assert.match(t1.aiResponse, /科技区/)
assert.match(t1.aiResponse, /深看/)
assert.match(t1.userMessage, /不是主人说的话/)
const t2 = turnForGraphEvent(taken.events[1])
assert.match(t2.aiResponse, /这条鱼好可爱/)
assert.equal(turnForGraphEvent({ kind: 'unknown' }), null)
assert.equal(turnForGraphEvent({ kind: 'bili-watch', title: '' }), null)

// 5) 失败回滚：.processing 并回主队列（期间新写的事件不丢）
pushGraphEvent({ kind: 'bili-watch', bvid: 'BV1St4Y6jEkc', title: '回滚后', mode: 'meta' }, { file })
const rolled = rollbackGraphEvents({ moved: taken.moved, file })
assert.equal(rolled.ok, true)
const after = readGraphEvents({ file })
assert.equal(after.length, 3)
assert.equal(fs.existsSync(taken.moved), false)

// 6) 提交：删掉 .processing，主队列不再动
const taken2 = takeGraphEvents({ file })
assert.equal(taken2.events.length, 3)
assert.equal(commitGraphEvents(taken2).ok, true)
assert.equal(fs.existsSync(taken2.moved), false)
assert.equal(readGraphEvents({ file }).length, 0)

// 7) 空文件 / 不存在的文件都安全
assert.deepEqual(takeGraphEvents({ file }).events, [])
assert.deepEqual(takeGraphEvents({ file: path.join(dir, 'nope.jsonl') }).events, [])

// 8) 插件进程 drain：事件 → enqueue → flush，成功后队列清空
const drainFile = path.join(dir, 'drain.jsonl')
pushGraphEvent({ kind: 'bili-watch', bvid: 'BV1St4Y6jEkc', title: '入图测试', mode: 'meta' }, { file: drainFile })
const seen = []
const fakeGraph = { enqueue: (t) => seen.push(t), flush: async () => {} }
const drain = createGraphOutboxDrain({ file: drainFile, getGraph: async () => fakeGraph, pluginLog: () => {} })
const r8 = await drain.drainOnce()
assert.equal(r8.ok, true)
assert.equal(r8.ingested, 1)
assert.equal(seen.length, 1)
assert.match(seen[0].aiResponse, /入图测试/)
assert.equal(fs.existsSync(drainFile), false)

// 9) 引擎起不来：整批回滚，队列还在，下次能重试
pushGraphEvent({ kind: 'bili-watch', bvid: 'BV1St4Y6jEkc', title: '失败重试', mode: 'meta' }, { file: drainFile })
const drain2 = createGraphOutboxDrain({ file: drainFile, getGraph: async () => { throw new Error('缺 key') }, pluginLog: () => {} })
const r9 = await drain2.drainOnce()
assert.equal(r9.ok, false)
assert.equal(readGraphEvents({ file: drainFile }).length, 1)
assert.match(String(r9.error), /缺 key/)

fs.rmSync(dir, { recursive: true, force: true })
console.log('ok graph-outbox: push/take/commit/rollback/映射/drain 9 组断言通过')
