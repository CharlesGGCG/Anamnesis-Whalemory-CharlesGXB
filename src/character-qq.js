// 角色 QQ 桥接的纯逻辑（可测）：白名单、文本提取、回复切分、触发判断。
//
// 设计：小C 不跑 DSH agent 会话，走 pet-api 的 /chat（带 characterId），
// 复用她的 人格卡 + 记忆卡 + vault + 日记，不碰鲸鱼的 QQ 工具链。

/** OneBot 事件 → 纯文本（去掉 CQ 码/图片标记，保留文字）。 */
export function qqEventText(event) {
  const raw = String(event?.raw_message ?? '').trim()
  if (raw) {
    return raw
      .replace(/\[CQ:[^\]]+\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  const segs = Array.isArray(event?.message) ? event.message : []
  return segs
    .filter((s) => s?.type === 'text')
    .map((s) => String(s?.data?.text ?? ''))
    .join('')
    .trim()
}

/** 是否允许这个会话（私聊/群）触发她。 */
export function isAllowed(config, kind, id) {
  const allow = config?.allow || {}
  if (kind === 'private') {
    if (allow.allowAllPrivate === true) return true
    const list = (allow.private || []).map(String)
    return list.includes(String(id))
  }
  if (kind === 'group') {
    const list = (allow.groups || []).map(String)
    return list.includes(String(id))
  }
  return false
}

/** 群里是否在叫她（@ 或名字），私聊直接 true。 */
export function isCalled(config, kind, event) {
  if (kind === 'private') return true
  const names = (config?.groupTrigger || ['小C', '小c']).map(String)
  const raw = String(event?.raw_message ?? '')
  if (/\[CQ:at,[^\]]*\]/.test(raw)) return true
  return names.some((n) => n && raw.includes(n))
}

/** 长回复按句切分，每段不超过 maxLen。 */
export function splitReply(text, maxLen = 300) {
  const s = String(text ?? '').trim()
  if (!s) return []
  const limit = Math.max(40, Number(maxLen) || 300)
  if (s.length <= limit) return [s]
  const parts = []
  let rest = s
  while (rest.length > limit) {
    let cut = Math.max(rest.lastIndexOf('。', limit), rest.lastIndexOf('！', limit), rest.lastIndexOf('？', limit), rest.lastIndexOf('\n', limit))
    if (cut < limit * 0.4) cut = limit
    parts.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean).slice(0, 6)
}

/** 从 pet-api 的返回里取回复正文；沉默/空 → ''。 */
export function replyTextOf(result) {
  const t = String(result?.reply?.text ?? result?.text ?? '').trim()
  if (!t || t === '[沉默]' || t.includes('[沉默]')) return ''
  return t
}
