// 角色 QQ 桥接纯逻辑测试（不连网、不发消息）。
import assert from 'node:assert/strict'
import { qqEventText, isAllowed, isCalled, splitReply, replyTextOf } from '../src/character-qq.js'

// 1) 文本提取：CQ 码去掉、纯段拼接
assert.equal(qqEventText({ raw_message: '在吗[CQ:face,id=1] 小C' }), '在吗 小C')
assert.equal(qqEventText({ raw_message: '', message: [{ type: 'text', data: { text: '你好' } }, { type: 'image', data: { file: 'a.jpg' } }] }), '你好')
assert.equal(qqEventText({}), '')

// 2) 白名单
const cfg = { allow: { private: ['10001'], groups: ['20002'], allowAllPrivate: false } }
assert.equal(isAllowed(cfg, 'private', '10001'), true)
assert.equal(isAllowed(cfg, 'private', 10001), true)
assert.equal(isAllowed(cfg, 'private', '99999'), false)
assert.equal(isAllowed(cfg, 'group', '20002'), true)
assert.equal(isAllowed(cfg, 'group', '20003'), false)
assert.equal(isAllowed({ allow: { allowAllPrivate: true } }, 'private', '123'), true)

// 3) 群里是否在叫她
assert.equal(isCalled(cfg, 'private', {}), true)
assert.equal(isCalled(cfg, 'group', { raw_message: '小C 你在吗' }), true)
assert.equal(isCalled(cfg, 'group', { raw_message: '[CQ:at,qq=123] 出来' }), true)
assert.equal(isCalled(cfg, 'group', { raw_message: '今天天气不错' }), false)

// 4) 回复切分
assert.deepEqual(splitReply(''), [])
assert.deepEqual(splitReply('短句。'), ['短句。'])
const long = Array.from({ length: 12 }, (_, i) => `这是第${i + 1}句话。`).join('')
const parts = splitReply(long, 40)
assert.ok(parts.length > 1)
assert.ok(parts.every((p) => p.length <= 40))
assert.equal(parts.join('').replace(/\s+/g, ''), long.replace(/\s+/g, ''))

// 5) 沉默/空
assert.equal(replyTextOf({ reply: { text: '' } }), '')
assert.equal(replyTextOf({ reply: { text: '[沉默]' } }), '')
assert.equal(replyTextOf({ reply: { text: '嗯。' } }), '嗯。')

console.log('ok character-qq: 文本/白名单/叫名/切分/沉默 5 组断言通过')
