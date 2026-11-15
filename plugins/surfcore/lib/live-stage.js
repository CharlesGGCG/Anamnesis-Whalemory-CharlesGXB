// AgentL2D 直播舞台客户端：找就绪的渲染客户端，让她说话/表演。
//
//   const stage = createLiveStage({ baseUrl: 'http://127.0.0.1:61945' })
//   await stage.speak('「晚风」说：晚上好')
//
// 只封装 P0 需要的两个动作：state / speak。动作与歌曲播放走 utils 后续再加。
export function createLiveStage({ baseUrl = 'http://127.0.0.1:61945', onLog = () => {} } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '')
  let lastSpeakAt = 0
  let lastError = ''

  async function getState() {
    const res = await fetch(`${base}/api/studio/state`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`studio/state HTTP ${res.status}`)
    return res.json()
  }

  async function pickClient() {
    const state = await getState()
    const clients = Array.isArray(state?.clients) ? state.clients : []
    return clients.find((c) => c?.ready && c?.id) || null
  }

  async function speak(text, { performance = null } = {}) {
    const say = String(text ?? '').trim()
    if (!say) throw new Error('说话内容为空')
    const client = await pickClient()
    if (!client) throw new Error('没有就绪的直播页面（L2D 场景页未打开 / 未点启用声音）')
    if (client.telemetry && client.telemetry.audioReady === false) throw new Error('场景页还没启用声音（先在 OBS 里交互点一下）')
    const body = { text: say.slice(0, 300), clientId: client.id }
    if (performance) body.performance = performance
    const res = await fetch(`${base}/api/studio/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data?.error) throw new Error(data?.error || `studio/speak HTTP ${res.status}`)
    lastSpeakAt = Date.now()
    lastError = ''
    return data
  }

  return {
    getState,
    pickClient,
    speak,
    status: () => ({ baseUrl: base, lastSpeakAt, lastError }),
    _setError: (e) => { lastError = String(e?.message ?? e).slice(0, 160) },
  }
}
