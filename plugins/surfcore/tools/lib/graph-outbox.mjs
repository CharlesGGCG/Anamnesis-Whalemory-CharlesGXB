// 记忆图谱的「出站队列」。
//
// 为什么需要它：B站 工具（debrief / bili-watch / comment）都是**短进程**，
// 而记忆图谱的 `enqueue()` 只在内存里缓冲、`flush()` 才会真正抽取入图。
// 在短进程里直接 enqueue 会因为进程退出而丢；直接 await flush 又会让「看视频/发评论」
// 多等 2~5 秒（还要起一次 LLM）。所以拆开：
//   工具进程：只往 graph-outbox.jsonl 追加一行（同步、几毫秒）
//   插件进程：每分钟 take 一次，统一入图，成功了才删队列
//
// 文件：~/.dsh/surfcore/graph-outbox.jsonl（一行一个 JSON 事件）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function graphOutboxFile() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir() || '.', '.dsh')
  return path.join(home, 'surfcore', 'graph-outbox.jsonl')
}

/** 工具侧：追加一条事件。失败不抛（不能因为记忆队列坏了就让看视频失败）。 */
export function pushGraphEvent(event = {}, { file = graphOutboxFile() } = {}) {
  try {
    const kind = String(event?.kind ?? '').trim()
    if (!kind) return { ok: false, reason: '缺少 kind' }
    const item = { at: new Date().toISOString(), ...event, kind }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(item)}\n`, 'utf8')
    return { ok: true, item, file }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/** 只读：看队列里有什么（排障用）。 */
export function readGraphEvents({ file = graphOutboxFile(), max = 200 } = {}) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const rows = []
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch {}
      if (rows.length >= max) break
    }
    return rows
  } catch { return [] }
}

/**
 * 插件侧：把整个队列原子地「拿走」（rename 成 .processing）。
 * 入图成功后再 commit（删掉 .processing）；失败 rollback（并回去，下次重试）。
 * rename 是原子的，所以不会一边写一边被搬走读不全。
 */
export function takeGraphEvents({ file = graphOutboxFile() } = {}) {
  try {
    if (!fs.existsSync(file)) return { ok: true, events: [], moved: '' }
    if (fs.statSync(file).size === 0) { try { fs.unlinkSync(file) } catch {} ; return { ok: true, events: [], moved: '' } }
    const moved = `${file}.processing`
    try { fs.unlinkSync(moved) } catch {}
    fs.renameSync(file, moved)
    const text = fs.readFileSync(moved, 'utf8')
    const events = []
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch {}
    }
    return { ok: true, events, moved }
  } catch (error) {
    return { ok: false, events: [], moved: '', reason: String(error?.message ?? error) }
  }
}

export function commitGraphEvents({ moved } = {}) {
  try { if (moved) fs.unlinkSync(moved); return { ok: true } } catch { return { ok: false } }
}

/** 失败回滚：把 .processing 并回主队列（期间工具可能又写了几行，所以用 append）。 */
export function rollbackGraphEvents({ moved, file } = {}) {
  try {
    if (!moved || !fs.existsSync(moved)) return { ok: false }
    // 目标文件默认从 moved 反推（去掉 .processing），避免误写回全局默认路径。
    const target = file || moved.replace(/\.processing$/, '')
    const text = fs.readFileSync(moved, 'utf8')
    fs.appendFileSync(target, text, 'utf8')
    fs.unlinkSync(moved)
    return { ok: true }
  } catch { return { ok: false } }
}

/**
 * 事件 → 图谱的一问一答。
 * 只认这几种 kind；别的返回 null（将来加新事件时，老插件进程会安全丢弃而不是报错）。
 *
 * ⚠️ 归属：引擎把 userMessage 当「主人说的话」，所以事件必须写在 aiResponse（她的那一侧），
 * userMessage 只放一句系统标记。否则「她看了视频」会被抽成「主人看了视频」。
 */
const ACTIVITY_MARK = '（系统记录：她刚结束一条 B站 活动，这不是主人说的话）'

export function turnForGraphEvent(ev = {}) {
  const kind = String(ev?.kind ?? '')
  const title = String(ev?.title ?? '').trim().slice(0, 120)
  const bvid = String(ev?.bvid ?? '').trim()
  const bvText = /^BV[0-9A-Za-z]{10}$/.test(bvid) ? `（${bvid}）` : ''
  if (kind === 'bili-watch') {
    if (!title) return null
    const bits = []
    if (ev.up) bits.push(`UP主 ${String(ev.up).slice(0, 60)}`)
    if (ev.tname) bits.push(`${String(ev.tname).slice(0, 30)}区`)
    if (ev.mode === 'full') bits.push('深看')
    else if (ev.mode === 'frames') bits.push('抽帧看')
    else bits.push('浅看')
    return {
      userMessage: ACTIVITY_MARK,
      aiResponse: `我今天在B站看了视频《${title}》${bvText}${bits.length ? `，${bits.join('，')}` : ''}。看完了，这条我记住了。`,
    }
  }
  if (kind === 'bili-comment') {
    const text = String(ev?.text ?? '').trim().slice(0, 400)
    if (!text) return null
    return {
      userMessage: ACTIVITY_MARK,
      aiResponse: `我在《${title || bvid}》${bvText}的评论区说：「${text}」`,
    }
  }
  return null
}
