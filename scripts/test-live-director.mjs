// 直播导演纯策略 + 最小执行测试（不连 B站、不连 L2D）。
import assert from 'node:assert/strict'
import { priorityOf, formatRead, shouldRead, createLiveDirector } from '../plugins/surfcore/lib/live-director.js'

// 1) 优先级：SC > 礼物 > 普通
assert.ok(priorityOf({ kind: 'sc' }) > priorityOf({ kind: 'gift' }))
assert.ok(priorityOf({ kind: 'gift' }) > priorityOf({ kind: 'danmaku' }))
assert.equal(priorityOf({ kind: 'enter' }), 0)

// 2) 念稿格式
assert.equal(formatRead({ kind: 'danmaku', name: '晚风', text: '晚上好' }), '「晚风」说：晚上好')
assert.equal(formatRead({ kind: 'sc', name: '星河', text: '加油', price: 30 }), '谢谢「星河」的超级留言：加油')
assert.equal(formatRead({ kind: 'gift', name: '小橘', gift: '小心心' }), '谢谢「小橘」的小心心')
assert.equal(formatRead({ kind: 'guard', name: '阿蓝' }), '谢谢「阿蓝」上舰')
assert.equal(formatRead({ kind: 'danmaku', name: 'X', text: '' }), '')
// 链接与换行清洗
assert.equal(formatRead({ kind: 'danmaku', name: 'X', text: '看这个https://a.b/c 好' }), '「X」说：看这个（链接） 好')

// 3) 过滤：太短 / 重复 dmid / 同名冷却 / 只读关
assert.equal(shouldRead({ kind: 'danmaku', name: 'a', text: '1' }).ok, false)
assert.equal(shouldRead({ kind: 'danmaku', name: 'a', text: '你好' }, { recentDmids: new Set(['d1']) , }).ok, true)
assert.equal(shouldRead({ kind: 'danmaku', name: 'a', text: '你好', dmid: 'd1' }, { recentDmids: new Set(['d1']) }).ok, false)
assert.equal(shouldRead({ kind: 'danmaku', name: 'a', text: '你好' }, { cfg: { nameGapMs: 60_000 }, recentNames: new Map([['a', Date.now()]]), now: Date.now() }).ok, false)
assert.equal(shouldRead({ kind: 'danmaku', name: 'a', text: '你好' }, { cfg: { read: false } }).ok, false)

// 4) 真执行：假 stage，念一次并节流
const spoken = []
const stage = { speak: async (t) => { spoken.push(t) }, _setError: () => {} }
const director = createLiveDirector({ stage, config: { minGapMs: 0, nameGapMs: 0, maxPerMinute: 10 }, log: () => {} })
director.start()
assert.equal(director.push({ kind: 'danmaku', name: 'a', text: '第一条', dmid: 'x1' }).ok, true)
assert.equal(director.push({ kind: 'danmaku', name: 'a', text: '第一条', dmid: 'x1' }).ok, false)
await new Promise((r) => setTimeout(r, 1600))
assert.ok(spoken.length >= 1, '应该念出至少一条')
assert.match(spoken[0], /「a」说：第一条/)
director.stop()
console.log('ok live-director: 优先级/格式/过滤/执行 4 组断言通过')
