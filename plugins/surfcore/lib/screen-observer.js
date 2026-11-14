// lib/screen-observer.js —— 鲸鱼陪看：定时截屏 + 变化检测 + 视觉理解
// 每 30 秒抽一帧缩略图；画面没变就跳过（省 token）；变了才喂视觉模型，5 分钟内冷却。
// 视觉 prompt 强制脱敏：只描述「主人在做什么」，不读屏幕上的文字/密码/聊天/代码。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

export function createScreenObserver({ ctx, stateDir, pluginLog = () => {} }) {
  const OBS_FILE = path.join(stateDir, 'screen-observation.json')
  const TMP_FILE = path.join(stateDir, 'screen-frame.jpg')
  // 可配置参数（网页控制端可运行时改）
  let cfg = {
    enabled: true,
    intervalMs: 30 * 1000,       // 抽帧频率
    cooldownMs: 5 * 60 * 1000,   // 画面变化后冷却
    model: '',                    // 空 = 用 memory-graph.config.json 的 visionModel / 默认 Qwen3-VL-8B
  }

  let timer = null
  let lastHash = ''
  let lastNote = ''
  let lastAt = 0
  let busy = false
  let devPageSkipped = false

  // 开发者页隐身（2026-11-13 主人定：她们不许监视开发者页）：
  // whaleweb 的「思考后台」打开时每 5 秒写一次 <stateDir>/devpage.json；
  // 只要它是「开着且页面可见」且心跳不超过 15 秒，就整轮不截屏、不看图。
  function devPageVisible() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(stateDir, 'devpage.json'), 'utf8'))
      return j?.open === true && j?.visible === true && Date.now() - Number(j.at || 0) < 15000
    } catch { return false }
  }

  function readObs() {
    try { return JSON.parse(fs.readFileSync(OBS_FILE, 'utf8')) } catch { return { note: '', at: 0 } }
  }
  function writeObs(note, at) {
    try { fs.writeFileSync(OBS_FILE, JSON.stringify({ note, at })) } catch {}
  }

  // 截屏并缩放到 800x450 JPEG，返回 { hash, base64 } 或 null
  function capture() {
    return new Promise((resolve) => {
      const tmp = TMP_FILE.replace(/\\/g, '\\\\')
      const ps = [
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$sw=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width',
        '$sh=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height',
        '$b=New-Object System.Drawing.Bitmap($sw,$sh)',
        '$g=[System.Drawing.Graphics]::FromImage($b)',
        '$g.CopyFromScreen(0,0,0,0,$b.Size)',
        '$o=New-Object System.Drawing.Bitmap(800,450)',
        '$g2=[System.Drawing.Graphics]::FromImage($o)',
        '$g2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
        '$g2.DrawImage($b,0,0,800,450)',
        `$o.Save('${tmp}',[System.Drawing.Imaging.ImageFormat]::Jpeg)`,
        '$g.Dispose();$g2.Dispose();$b.Dispose();$o.Dispose()',
      ].join(';')
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 12000, windowsHide: true }, (err) => {
        if (err) return resolve(null)
        try {
          const buf = fs.readFileSync(TMP_FILE)
          const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16)
          resolve({ hash, base64: buf.toString('base64') })
        } catch { resolve(null) }
      })
    })
  }

  // 视觉理解：SiliconFlow 视觉模型（OpenAI 兼容 image_url），只描述主人在做什么（隐私脱敏）
  async function vision(base64) {
    try {
      let sf = {}
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'memory-graph.config.json'), 'utf8'))
        sf = raw?.siliconflow && typeof raw.siliconflow === 'object' ? raw.siliconflow : {}
      } catch {}
      const apiKey = String(sf.apiKey || process.env.SILICONFLOW_API_KEY || '').trim()
      const baseUrl = String(sf.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
      const visionModel = String(cfg.model || sf.visionModel || 'Qwen/Qwen3-VL-8B-Instruct').trim()
      if (!apiKey) { pluginLog('[陪看] 缺 SiliconFlow key'); return null }
      const prompt = '看一眼这张截图，一句话描述主人现在在做什么（比如：在写代码、在玩游戏、在看视频、在浏览网页、在聊天、在发呆）。只描述活动类型，绝对不要读出屏幕上的任何具体文字、代码内容、聊天内容、密码或个人信息。如果看不出，就说「看不出在做什么」。'
      const body = {
        model: visionModel,
        messages: [
          { role: 'system', content: '你是小鲸鱼，正陪在主人电脑边。下面是主人屏幕此刻的截图。' },
          { role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          ] },
        ],
        max_tokens: 200,
        temperature: 0.3,
        stream: false,
      }
      pluginLog('[陪看] 视觉模型：', visionModel)
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      if (!r.ok) { pluginLog('[陪看] SiliconFlow HTTP', String(r.status)); return null }
      const j = await r.json().catch(() => ({}))
      const content = j?.choices?.[0]?.message?.content
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((c) => String(c?.text || '')).join('') : '')
      const note = String(text || '').trim().slice(0, 200)
      return note || null
    } catch (e) {
      pluginLog('[陪看] 视觉理解失败：', String(e?.message ?? e).slice(0, 160))
      return null
    }
  }

  async function observe() {
    if (busy) return
    if (devPageVisible()) {
      if (!devPageSkipped) { devPageSkipped = true; pluginLog('[陪看] 开发者在看开发者页，暂停截屏') }
      return
    }
    if (devPageSkipped) { devPageSkipped = false; pluginLog('[陪看] 开发者页已关，恢复截屏') }
    busy = true
    try {
      const frame = await capture()
      if (!frame) { pluginLog('[陪看] 截屏失败'); return }
      if (frame.hash === lastHash) return       // 画面没变，跳过
      lastHash = frame.hash
      const now = Date.now()
      if (lastAt && now - lastAt < cfg.cooldownMs) return  // 冷却中
      pluginLog('[陪看] 画面有变化，看图…')
      const note = await vision(frame.base64)
      pluginLog('[陪看] 视觉结果：', note || '（空）')
      if (note) {
        lastNote = note
        lastAt = now
        writeObs(note, now)
        try { fs.copyFileSync(TMP_FILE, path.join(stateDir, 'screen-last.jpg')) } catch {}
        pluginLog(`[陪看] ${note}`)
      }
    } finally {
      busy = false
    }
  }

  function start() {
    const o = readObs()
    lastNote = o.note || ''
    lastAt = o.at || 0
    if (timer) clearInterval(timer)
    timer = setInterval(() => { void observe() }, Math.max(5000, cfg.intervalMs || 30000))
    void observe()
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  // 运行时改配置：开关、频率、冷却、模型。改完立即生效（开关/频率变化时重启 timer）。
  function setConfig(patch = {}) {
    if (patch && typeof patch === 'object') {
      if (patch.enabled !== undefined) cfg.enabled = patch.enabled === true
      if (patch.intervalMs !== undefined) cfg.intervalMs = Math.min(600000, Math.max(5000, Number(patch.intervalMs) || 30000))
      if (patch.cooldownMs !== undefined) cfg.cooldownMs = Math.min(3600000, Math.max(60000, Number(patch.cooldownMs) || 300000))
      if (patch.model !== undefined) cfg.model = String(patch.model || '').trim().slice(0, 80)
    }
    if (cfg.enabled) start()
    else stop()
    return status()
  }

  function status() {
    return {
      enabled: cfg.enabled,
      running: Boolean(timer),
      intervalMs: cfg.intervalMs,
      cooldownMs: cfg.cooldownMs,
      model: cfg.model || '（默认 Qwen/Qwen3-VL-8B）',
      note: lastNote,
      at: lastAt,
      pausedByDevPage: devPageVisible(),
    }
  }

  return {
    start,
    stop,
    setConfig,
    status,
    observation: () => ({ note: lastNote, at: lastAt }),
  }
}
