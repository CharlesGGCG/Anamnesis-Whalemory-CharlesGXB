// 直播服务：弹幕接入 + 读/回弹幕导演 + 点歌唱歌 + L2D 舞台。
//
// config.json 的 live 段：
//   { enabled, room, stageUrl, characterId,
//     danmaku: { read, reply, minGapMs, nameGapMs, maxPerMinute, queueMax },
//     song: { enabled, queueMax, cooldownMs } }
import fs from 'node:fs'
import path from 'node:path'
import { createLiveDanmaku } from './live-danmaku.js'
import { createLiveStage } from './live-stage.js'
import { createLiveDirector } from './live-director.js'
import { createSongPlayer } from './song-player.js'
import { loadSongs, pickSong, parseSongRequest, createSongQueue, parseLrc, lyricAt } from './songbook.js'
import { characterPaths, readCurrentCharacter } from '../../../src/character-persona.js'

function loadLiveConfig(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'))
    return raw?.live && typeof raw.live === 'object' ? raw.live : {}
  } catch { return {} }
}

export function createLiveService({ stateDir, pluginLog = () => {}, config = null, chat = null } = {}) {
  const cfg = config || loadLiveConfig(stateDir)
  const room = Number(cfg.room) || 14103983
  const characterId = String(cfg.characterId || readCurrentCharacter()?.id || '')
  const liveDir = characterId ? path.join(characterPaths(characterId).dir, 'live') : path.join(stateDir, 'live')
  const songsFile = path.join(liveDir, 'songs.json')
  const songCfg = cfg.song && typeof cfg.song === 'object' ? cfg.song : {}
  const stage = createLiveStage({ baseUrl: String(cfg.stageUrl || 'http://127.0.0.1:61945'), onLog: pluginLog })
  const brain = chat && typeof chat.chat === 'function'
    ? (event) => chat.chat({ text: `「${event.name}」说：${event.text}`, identity: 'owner', web: false, live: true, ...(characterId ? { characterId } : {}) })
    : null
  const director = createLiveDirector({ stage, brain, config: cfg.danmaku || {}, log: pluginLog })
  const player = createSongPlayer({ onLog: pluginLog })
  const queue = createSongQueue({ max: Number(songCfg.queueMax) || 5, cooldownMs: Number(songCfg.cooldownMs) || 10 * 60_000 })
  const danmaku = createLiveDanmaku({ room, onEvent: (event) => handleEvent(event), onLog: pluginLog })

  let startedAt = 0
  let lastError = ''
  let singing = false
  let nowSong = null
  let lyricsTimer = null
  let songTimer = null
  let lastLyric = ''

  async function say(text) {
    try { await stage.speak(String(text).slice(0, 120)) } catch (error) {
      pluginLog('[唱歌] 说话失败：', String(error?.message ?? error).slice(0, 120))
    }
  }

  function handleEvent(event) {
    if (event?.kind === 'danmaku' && songCfg.enabled !== false) {
      const req = parseSongRequest(event.text)
      if (req) { void requestSong(req.title, event); return }
    }
    director.push(event)
  }

  async function requestSong(query, event) {
    const songs = loadSongs(songsFile)
    const pick = pickSong(songs, query)
    if (!pick) { await say(`没找到「${query}」这首，换一首吧`); return }
    const r = queue.enqueue({ song: pick.song, uid: event.uid, name: event.name })
    if (!r.ok) { await say(`${r.reason}`); return }
    pluginLog(`[唱歌] ${event.name} 点了《${pick.song.title}》`)
    await say(`好，下一首《${pick.song.title}》`)
  }

  function tickSong() {
    if (singing || !queue.size()) return
    const entry = queue.next()
    if (!entry) return
    singing = true
    nowSong = entry.song
    lastLyric = ''
    director.setPaused(true)
    void playSong(entry)
  }

  async function playSong(entry) {
    const s = entry.song
    try {
      const audio = path.isAbsolute(s.audio) ? s.audio : path.join(liveDir, s.audio)
      const lrcFile = s.lrc ? (path.isAbsolute(s.lrc) ? s.lrc : path.join(liveDir, s.lrc)) : ''
      const lrc = lrcFile && fs.existsSync(lrcFile) ? parseLrc(fs.readFileSync(lrcFile, 'utf8')) : []
      await player.play({ file: audio })
      pluginLog(`[唱歌] 开始《${s.title}》`)
      lyricsTimer = setInterval(async () => {
        try {
          const st = await player.status()
          const cursor = Number(st.mediaCursor || 0)
          const dur = Number(st.mediaDuration || s.duration || 0)
          const line = lyricAt(lrc, cursor)
          if (line && line !== lastLyric) { lastLyric = line; await player.setLyrics(line) }
          const state = String(st.mediaState || '')
          if (state.endsWith('ENDED') || state.endsWith('STOPPED') || (dur && cursor >= dur - 800)) finishSong()
        } catch (error) {
          pluginLog('[唱歌] 状态查询失败，结束这首：', String(error?.message ?? error).slice(0, 120))
          finishSong()
        }
      }, 1800)
    } catch (error) {
      pluginLog('[唱歌] 播放失败：', String(error?.message ?? error).slice(0, 160))
      finishSong()
    }
  }

  function finishSong() {
    if (lyricsTimer) { clearInterval(lyricsTimer); lyricsTimer = null }
    queue.done()
    singing = false
    nowSong = null
    director.setPaused(false)
    void player.stop()
    pluginLog('[唱歌] 这首结束')
  }

  async function start() {
    try {
      director.start()
      await danmaku.start()
      if (songTimer) clearInterval(songTimer)
      songTimer = setInterval(() => tickSong(), 2500)
      try { songTimer.unref?.() } catch {}
      startedAt = Date.now()
      lastError = ''
      pluginLog(`[直播] 已启动：房间 ${room}，曲库 ${loadSongs(songsFile).length} 首`)
      return { ok: true, room }
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 200)
      pluginLog('[直播] 启动失败：', lastError)
      return { ok: false, error: lastError }
    }
  }

  async function stop() {
    director.stop()
    if (songTimer) { clearInterval(songTimer); songTimer = null }
    if (singing) finishSong()
    await danmaku.stop()
    startedAt = 0
    pluginLog('[直播] 已停止')
    return { ok: true }
  }

  async function test({ author = '测试观众', text = '主播晚上好' } = {}) {
    const event = { kind: 'danmaku', name: String(author).slice(0, 40), text: String(text).slice(0, 200), dmid: `test-${Date.now()}`, at: Date.now() }
    if (songCfg.enabled !== false) {
      const req = parseSongRequest(event.text)
      if (req) { await requestSong(req.title, event); return { ok: true, song: req.title } }
    }
    return director.push(event)
  }

  return {
    start, stop, test, stage, director,
    status: () => ({
      enabled: cfg.enabled === true,
      room,
      startedAt,
      lastError,
      danmaku: danmaku.status(),
      director: director.status(),
      stage: stage.status(),
      song: { queued: queue.size(), singing, playing: nowSong?.title || nowSong?.id || '', lyrics: lastLyric, file: songsFile, player: player.statusInfo() },
    }),
  }
}
