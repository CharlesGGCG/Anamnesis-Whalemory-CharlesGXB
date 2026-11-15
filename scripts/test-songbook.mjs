// 曲库/点歌纯逻辑测试（不连 OBS、不连 B站）。
import assert from 'node:assert/strict'
import { parseSongRequest, scoreMatch, pickSong, parseLrc, lyricAt, createSongQueue } from '../plugins/surfcore/lib/songbook.js'

// 1) 点歌解析
assert.deepEqual(parseSongRequest('点歌 晴天'), { title: '晴天' })
assert.deepEqual(parseSongRequest('来一首：夜曲'), { title: '夜曲' })
assert.deepEqual(parseSongRequest('唱一首 告白气球！'), { title: '告白气球' })
assert.equal(parseSongRequest('今天天气不错'), null)
assert.equal(parseSongRequest('点歌'), null)

// 2) 匹配：同名 > 包含 > 残词；unknown 不选
const songs = [
  { title: '晴天', artist: '周杰伦', audio: 'a.mp3', license: 'cover' },
  { title: '夜曲', artist: '周杰伦', audio: 'b.mp3', license: 'cover' },
  { title: '禁播歌', audio: 'c.mp3', license: 'unknown' },
]
assert.equal(pickSong(songs, '晴天').song.title, '晴天')
assert.equal(pickSong(songs, '杰伦').song.title, '晴天')
assert.ok(scoreMatch(songs[0], '晴') > 0)
assert.equal(pickSong(songs, '禁播歌'), null, 'unknown 不可播')
assert.equal(pickSong(songs, '不存在的歌'), null)

// 3) LRC
const lrc = parseLrc('[00:01.00]第一句\n[00:03.50]第二句\n[00:05.00]第三句')
assert.equal(lrc.length, 3)
assert.equal(lyricAt(lrc, 0), '')
assert.equal(lyricAt(lrc, 1200), '第一句')
assert.equal(lyricAt(lrc, 3600), '第二句')
assert.equal(lyricAt(lrc, 9999), '第三句')

// 4) 队列：冷却 / 上限 / 版权
const q = createSongQueue({ max: 2, cooldownMs: 60_000 })
assert.equal(q.enqueue({ song: songs[0], uid: 'u1', name: '甲', now: 0 }).ok, true)
assert.equal(q.enqueue({ song: songs[1], uid: 'u1', name: '甲', now: 1000 }).ok, false, '同人冷却')
assert.equal(q.enqueue({ song: songs[2], uid: 'u2', name: '乙', now: 0 }).ok, false, 'unknown 不可播')
assert.equal(q.enqueue({ song: songs[1], uid: 'u2', name: '乙', now: 0 }).ok, true)
assert.equal(q.enqueue({ song: songs[1], uid: 'u3', name: '丙', now: 0 }).ok, false, '队列满')
assert.equal(q.size(), 2)
const first = q.next()
assert.equal(first.song.title, '晴天')
assert.equal(q.next(), null, '正在播放时不能再取')
q.done()
assert.equal(q.next().song.title, '夜曲')

console.log('ok songbook: 解析/匹配/LRC/队列 4 组断言通过')
