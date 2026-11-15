// 曲库与点歌（纯逻辑可测）：解析「点歌 xxx」、模糊匹配、队列、LRC。
//
// 曲库文件：characters/<id>/live/songs.json
//   [{ id, title, artist, audio, lrc, duration, tags, license: 'own'|'cover'|'unknown' }]
// 版权：unknown 默认不播（直播场景避免侵权），own/cover 可播。
import fs from 'node:fs'
import path from 'node:path'

export const LICENSES = ['own', 'cover', 'unknown']

export function parseSongRequest(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  const m = s.match(/^(?:点歌|点一首|唱一首|唱个|来一首|想听)\s*[:：]?\s*(.+)$/)
  if (!m) return null
  const title = m[1].trim().replace(/[。！!？?]+$/, '')
  return title ? { title } : null
}

export function scoreMatch(song, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return 0
  const title = String(song?.title ?? '').toLowerCase()
  const artist = String(song?.artist ?? '').toLowerCase()
  if (title === q) return 100
  if (title.includes(q)) return 80
  if (q.includes(title)) return 70
  if (artist && artist.includes(q)) return 40
  let hit = 0
  for (const ch of new Set(q)) if (title.includes(ch)) hit += 1
  return hit >= Math.min(2, q.length) ? 20 + hit : 0
}

export function pickSong(songs, query) {
  const list = Array.isArray(songs) ? songs : []
  let best = null
  let bestScore = 0
  for (const s of list) {
    if (s?.license === 'unknown') continue
    const score = scoreMatch(s, query)
    if (score > bestScore) { best = s; bestScore = score }
  }
  return best ? { song: best, score: bestScore } : null
}

export function playable(song) {
  if (!song) return false
  if (song.license === 'unknown') return false
  return Boolean(song.audio)
}

/** LRC：[mm:ss.xx] 歌词 → [{ t: 毫秒, text }]，按时间排序。 */
export function parseLrc(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const times = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!times.length) continue
    const phrase = line.replace(/\[[^\]]+\]/g, '').trim()
    if (!phrase) continue
    for (const m of times) {
      const min = Number(m[1]); const sec = Number(m[2]); const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0
      out.push({ t: min * 60_000 + sec * 1000 + frac, text: phrase })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

export function lyricAt(lrc, ms) {
  let current = ''
  for (const line of lrc) {
    if (line.t <= ms) current = line.text
    else break
  }
  return current
}

export function loadSongs(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(raw) ? raw : Array.isArray(raw?.songs) ? raw.songs : []
  } catch { return [] }
}

export function saveSongs(file, songs) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, songs }, null, 2)}\n`, 'utf8')
}

export function createSongQueue({ max = 5, cooldownMs = 10 * 60_000 } = {}) {
  const items = []
  const lastByUser = new Map()
  let playing = null

  function enqueue({ song, uid = '', name = '观众', now = Date.now() }) {
    if (!playable(song)) return { ok: false, reason: '这首歌不能播（版权/缺音频）' }
    const key = String(uid || name)
    const last = lastByUser.has(key) ? lastByUser.get(key) : -Infinity
    if (now - last < cooldownMs) return { ok: false, reason: `同一人 ${Math.round(cooldownMs / 60000)} 分钟内只能点一首` }
    if (items.length >= max) return { ok: false, reason: `点歌队列满了（${max} 首）` }
    items.push({ song, uid: String(uid || ''), name: String(name || '').slice(0, 20), at: now })
    lastByUser.set(key, now)
    return { ok: true, queued: items.length }
  }

  function next() {
    if (playing) return null
    playing = items.shift() || null
    return playing
  }

  function done() { playing = null }

  return {
    enqueue, next, done,
    size: () => items.length,
    playing: () => playing,
    list: () => items.map((x) => `${x.song.title}（${x.name}）`),
  }
}
