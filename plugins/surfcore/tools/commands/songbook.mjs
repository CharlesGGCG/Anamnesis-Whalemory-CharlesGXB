// 曲库维护（按角色）：list / add / remove
//
//   node songbook.mjs list [--character claude]
//   node songbook.mjs add --title "歌名" --audio songs/xxx.mp3 [--artist 谁] [--lrc songs/xxx.lrc] [--license own|cover|unknown]
//   node songbook.mjs remove --title "歌名"
//
// 音频/LRC 路径相对 characters/<id>/live/，也可以给绝对路径。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { characterPaths, readCurrentCharacter } from '../../../../src/character-persona.js'
import { loadSongs, saveSongs } from '../../lib/songbook.js'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'list'
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const characterId = String(args.get('character') ?? '').trim() || readCurrentCharacter()?.id || ''
const dir = path.join(characterPaths(characterId).dir, 'live')
const file = path.join(dir, 'songs.json')

if (cmd === 'list') {
  const songs = loadSongs(file)
  if (!songs.length) { console.log(`（${file} 还是空的）`); process.exit(0) }
  for (const s of songs) {
    const audio = s.audio && (path.isAbsolute(s.audio) ? s.audio : path.join(dir, s.audio))
    const ok = audio && fs.existsSync(audio)
    console.log(`- ${s.title}${s.artist ? ` / ${s.artist}` : ''}  [${s.license || 'unknown'}]  ${ok ? '✓' : '✗ 缺音频'}  ${s.audio}`)
  }
  process.exit(0)
}

if (cmd === 'add') {
  const title = String(args.get('title') ?? '').trim()
  const audio = String(args.get('audio') ?? '').trim()
  if (!title || !audio) { console.error('需要 --title 和 --audio'); process.exit(2) }
  const songs = loadSongs(file)
  const idx = songs.findIndex((s) => s.title === title)
  const entry = {
    id: idx >= 0 ? songs[idx].id : `s${Date.now().toString(36)}`,
    title,
    artist: String(args.get('artist') ?? ''),
    audio,
    lrc: String(args.get('lrc') ?? ''),
    duration: Number(args.get('duration')) || 0,
    tags: [],
    license: ['own', 'cover', 'unknown'].includes(String(args.get('license'))) ? String(args.get('license')) : 'unknown',
  }
  if (idx >= 0) songs[idx] = entry; else songs.push(entry)
  saveSongs(file, songs)
  console.log(`${idx >= 0 ? '已更新' : '已添加'}：${title}（${entry.license}）→ ${file}`)
  process.exit(0)
}

if (cmd === 'remove') {
  const title = String(args.get('title') ?? '').trim()
  const songs = loadSongs(file).filter((s) => s.title !== title)
  saveSongs(file, songs)
  console.log(`剩余 ${songs.length} 首`)
  process.exit(0)
}

console.error('用法：list | add --title --audio [--artist --lrc --license] | remove --title')
process.exit(2)
