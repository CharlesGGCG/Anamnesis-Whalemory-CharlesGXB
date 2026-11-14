// 日记调度：每天晚上（北京时间，默认 22 点后）给每个角色写当天日记。
//
// 规则：
//   · 当天已经有日记就跳过（不重复写）
//   · 当天的素材少于 minItems（记忆卡记录 + 聊天消息）就跳过，避免硬写流水账
//   · 生成失败只记日志，不重试到把 token 烧光
import { listCharacters } from '../../../src/character-persona.js'
import { appendDiary, collectDiary, diaryMaterial, hasDiaryToday } from '../../../src/character-diary.js'

export function createDiaryScheduler({ pluginLog = () => {}, intervalMs = 10 * 60_000, hour = 22, minItems = 8 } = {}) {
  let timer = null
  let busy = false
  let lastError = ''
  let lastWroteAt = 0

  function hourNow() {
    try {
      return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()))
    } catch { return new Date().getHours() }
  }

  async function tick() {
    if (busy) return { ok: true, skipped: true }
    if (hourNow() < hour) return { ok: true, skipped: 'too-early' }
    busy = true
    try {
      const chars = listCharacters()
      const targets = chars.length ? chars : [{ id: '', name: '当前角色' }]
      let wrote = 0
      for (const c of targets) {
        try {
          if (hasDiaryToday(c.id)) continue
          const material = diaryMaterial({ characterId: c.id, days: 1 })
          if (material.length < minItems) continue
          const r = await collectDiary({ characterId: c.id, days: 1 })
          if (!r.ok) { pluginLog(`[日记] ${c.name || '当前角色'} 生成失败：${r.reason}`); continue }
          const w = appendDiary({ characterId: c.id, text: r.diary, mood: r.mood })
          if (w.ok) { wrote += 1; pluginLog(`[日记] ${c.name || '当前角色'} 写了今天（素材 ${r.items.length} 条）`) }
        } catch (error) {
          pluginLog(`[日记] ${c.name || '当前角色'} 失败：`, String(error?.message ?? error).slice(0, 160))
        }
      }
      if (wrote) lastWroteAt = Date.now()
      lastError = ''
      return { ok: true, wrote }
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 180)
      pluginLog('[日记] 调度失败：', lastError)
      return { ok: false, error: lastError }
    } finally {
      busy = false
    }
  }

  function start() {
    if (timer) return
    void tick()
    timer = setInterval(() => { void tick() }, Math.max(60_000, Number(intervalMs) || 600_000))
    try { timer.unref?.() } catch {}
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { start, stop, tick, status: () => ({ running: Boolean(timer), busy, hour, lastError, lastWroteAt }) }
}
