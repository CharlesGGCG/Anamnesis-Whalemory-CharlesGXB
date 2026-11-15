// 直播导演（P0：只读弹幕，不回话）：
//   事件 → 队列（优先级/去重/同名冷却）→ 念出来（L2D speak）
//
// 纯策略函数导出，方便单测；真正的时序在 createLiveDirector 里。
export const LIVE_PRIORITY = { sc: 100, gift: 80, guard: 70, danmaku: 10 }

export function priorityOf(event) {
  return LIVE_PRIORITY[event?.kind] ?? 0
}

function cleanText(text, max = 80) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gi, '（链接）')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function formatRead(event, { maxText = 80 } = {}) {
  const name = cleanText(event?.name || '观众', 12)
  const text = cleanText(event?.text, maxText)
  if (event?.kind === 'sc') return text ? `谢谢「${name}」的超级留言：${text}` : `谢谢「${name}」的超级留言`
  if (event?.kind === 'gift') return `谢谢「${name}」的${cleanText(event?.gift, 20) || '礼物'}`
  if (event?.kind === 'guard') return `谢谢「${name}」上舰`
  if (!text || text.length < 1) return ''
  return `「${name}」说：${text}`
}

/** 这条事件该不该念（不含"现在能不能念"的时机判断）。 */
export function shouldRead(event, { cfg = {}, recentNames = new Map(), recentDmids = new Set(), now = Date.now() } = {}) {
  if (!event || event.kind === 'enter') return { ok: false, reason: 'enter' }
  if (cfg.read === false) return { ok: false, reason: 'read-off' }
  if (event.kind === 'danmaku') {
    const text = cleanText(event.text, 200)
    if (!text || text.length < 2) return { ok: false, reason: 'too-short' }
    if (text.length > 200) return { ok: false, reason: 'too-long' }
    if (event.dmid && recentDmids.has(event.dmid)) return { ok: false, reason: 'dup' }
    const last = recentNames.get(event.name) || 0
    if (now - last < (Number(cfg.nameGapMs) || 5 * 60_000)) return { ok: false, reason: 'name-gap' }
  }
  return { ok: true }
}

export function createLiveDirector({ stage, config = {}, log = () => {} } = {}) {
  const cfg = {
    read: config.read !== false,
    minGapMs: Number(config.minGapMs) || 20_000,
    nameGapMs: Number(config.nameGapMs) || 5 * 60_000,
    queueMax: Number(config.queueMax) || 30,
    maxPerMinute: Number(config.maxPerMinute) || 3,
  }
  const queue = []
  const recentNames = new Map()
  const recentDmids = new Set()
  const minuteStamps = []
  let running = false
  let speaking = false
  let lastReadAt = 0
  let readCount = 0
  let skipped = 0
  let timer = null
  let lastSpoken = ''

  function push(event) {
    const verdict = shouldRead(event, { cfg: { ...cfg, nameGapMs: cfg.nameGapMs }, recentNames, recentDmids, now: Date.now() })
    if (!verdict.ok) { skipped += 1; return { ok: false, reason: verdict.reason } }
    if (event.dmid) {
      recentDmids.add(event.dmid)
      if (recentDmids.size > 500) recentDmids.delete(recentDmids.values().next().value)
    }
    queue.push(event)
    if (queue.length > cfg.queueMax) queue.shift()
    void tick()
    return { ok: true, queued: queue.length }
  }

  function pick() {
    if (!queue.length) return null
    let best = 0
    for (let i = 1; i < queue.length; i += 1) {
      if (priorityOf(queue[i]) > priorityOf(queue[best])) best = i
    }
    return queue.splice(best, 1)[0]
  }

  async function tick() {
    if (!running || speaking || !queue.length) return
    const now = Date.now()
    if (now - lastReadAt < cfg.minGapMs) return
    const recent = minuteStamps.filter((t) => now - t < 60_000)
    if (recent.length >= cfg.maxPerMinute) return
    const event = pick()
    if (!event) return
    const text = formatRead(event)
    if (!text) { void tick(); return }
    speaking = true
    try {
      await stage.speak(text)
      lastReadAt = Date.now()
      minuteStamps.push(lastReadAt)
      readCount += 1
      lastSpoken = text
      recentNames.set(event.name, lastReadAt)
      log(`[直播] 念弹幕：${text}`)
    } catch (error) {
      skipped += 1
      stage._setError?.(error)
      log(`[直播] 念弹幕失败：${String(error?.message ?? error).slice(0, 160)}`)
      // 失败也记冷却，避免疯狂重试
      lastReadAt = Date.now()
    } finally {
      speaking = false
      if (running && queue.length) setTimeout(() => void tick(), 800)
    }
  }

  function start() {
    if (running) return
    running = true
    timer = setInterval(() => void tick(), 1000)
    try { timer.unref?.() } catch {}
    log(`[直播] 读弹幕已启动（间隔 ${Math.round(cfg.minGapMs / 1000)}s，同名冷却 ${Math.round(cfg.nameGapMs / 60_000)}min）`)
    void tick()
  }

  function stop() {
    running = false
    if (timer) { clearInterval(timer); timer = null }
    queue.length = 0
  }

  return {
    push,
    start,
    stop,
    config: { ...cfg },
    status: () => ({
      running, speaking, queued: queue.length, readCount, skipped,
      lastReadAt, lastSpoken, nameCooldowns: recentNames.size,
    }),
  }
}
