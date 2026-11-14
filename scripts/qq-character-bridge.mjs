// 角色 QQ 桥接（独立进程，不占 DSH 会话）——给第二个 QQ 号（小C）用。
//
//   node scripts/qq-character-bridge.mjs --character claude --init   # 写配置模板
//   node scripts/qq-character-bridge.mjs --character claude --dry    # 只读：收到消息只打印，不回
//   node scripts/qq-character-bridge.mjs --character claude          # 真跑
//
// 链路：第二个 SnowLuma（OneBot WS）→ 本进程 → pet-api /chat（带 characterId）→ SnowLuma 发回。
// 用她自己的 人格卡/记忆卡/vault/日记；不碰鲸鱼的 QQ 工具链，也不开 DSH agent 会话。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SnowLumaWebSocketClient, text as qqText } from '@snowluma/sdk'
import { qqEventText, isAllowed, isCalled, splitReply, replyTextOf } from '../src/character-qq.js'
import { characterPaths, readCurrentCharacter } from '../src/character-persona.js'

const argv = process.argv.slice(2)
const args = new Map()
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}
const characterId = String(args.get('character') ?? '').trim() || 'claude'
const dry = args.has('dry')
const init = args.has('init')
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const configPath = String(args.get('config') ?? '').trim() || path.join(characterPaths(characterId).dir, 'qq.json')
const logFile = path.join(HOME, 'surfcore', `qq-${characterId}.log`)

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
  console.log(line)
  try { fs.appendFileSync(logFile, `${line}\n`, 'utf8') } catch {}
}

function readHost() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'surfcore', 'pet', 'host.json'), 'utf8')) } catch { return null }
}

const TEMPLATE = {
  enabled: false,
  wsUrl: 'ws://127.0.0.1:3012',
  accessToken: '',
  selfQQ: '',
  petApi: { baseUrl: '', token: '' },
  allow: { private: [], groups: [], allowAllPrivate: false },
  groupTrigger: ['小C', '小c'],
  limits: { maxLen: 300, minGapMs: 1200 },
}

if (init) {
  if (fs.existsSync(configPath)) { console.log(`已存在，不覆盖：${configPath}`); process.exit(0) }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(TEMPLATE, null, 2)}\n`, 'utf8')
  console.log(`已写模板：${configPath}\n填好 wsUrl/accessToken/selfQQ，并把主人的 QQ 加到 allow.private，enabled 改 true。`)
  process.exit(0)
}

if (!fs.existsSync(configPath)) {
  console.error(`缺配置：${configPath}\n先跑 --init 生成模板，再填 SnowLuma 地址和令牌。`)
  process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
if (cfg.enabled !== true) { console.error(`配置里 enabled 不是 true（${configPath}），不启动。`); process.exit(2) }
if (!cfg.wsUrl) { console.error('配置缺 wsUrl（第二个 SnowLuma 的 OneBot WebSocket 地址）'); process.exit(2) }
const host = readHost()
const baseUrl = String(cfg.petApi?.baseUrl || host?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const petToken = String(cfg.petApi?.token || host?.token || '').trim()
const apiPath = String(cfg.petApi?.api || host?.api || '/dsh-surfcore/pet-api')
if (!petToken) { console.error('缺 pet-api 令牌（host.json 没有 token，也没在配置里填）'); process.exit(2) }

const maxLen = Number(cfg.limits?.maxLen) || 300
const minGapMs = Number(cfg.limits?.minGapMs) || 1200
const seen = new Set()
const lastAt = new Map()
let sending = false

function remember(key) {
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > 500) seen.delete(seen.values().next().value)
  return true
}

async function askPet(text) {
  const res = await fetch(`${baseUrl}${apiPath}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pet-token': petToken },
    body: JSON.stringify({ text, identity: 'owner', web: false, debug: false, characterId }),
    signal: AbortSignal.timeout(120_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

async function handle(kind, id, event, send) {
  if (String(event?.user_id ?? event?.sender?.user_id ?? '') === String(event?.self_id ?? '')) return
  if (!isAllowed(cfg, kind, id)) { log(`忽略（白名单外）${kind}:${id}`); return }
  if (!isCalled(cfg, kind, event)) return
  const say = qqEventText(event)
  if (!say) return
  const key = String(event?.message_id ?? `${kind}:${id}:${event?.time ?? ''}:${say}`)
  if (!remember(key)) return
  const now = Date.now()
  if (now - (lastAt.get(id) || 0) < minGapMs) { log(`限速跳过 ${kind}:${id}`); return }
  lastAt.set(id, now)
  log(`收到 ${kind}:${id} → ${say.slice(0, 60)}`)
  if (dry) { log('[dry] 不回复'); return }
  try {
    const t0 = Date.now()
    const data = await askPet(say)
    const reply = replyTextOf(data)
    log(`回复耗时 ${Date.now() - t0}ms，${reply ? reply.length + ' 字' : '沉默'}`)
    if (!reply) return
    for (const part of splitReply(reply, maxLen)) {
      await send(part)
      await new Promise((r) => setTimeout(r, 700 + Math.random() * 700))
    }
  } catch (error) {
    log('调用 pet-api 失败：', String(error?.message ?? error).slice(0, 200))
  }
}

const bot = new SnowLumaWebSocketClient({
  url: cfg.wsUrl,
  accessToken: cfg.accessToken || undefined,
  reconnect: true,
})

bot.onPrivateMessage((event) => {
  void handle('private', event.user_id, event, (part) => bot.sendPrivateMessage(Number(event.user_id), qqText(part)))
})
bot.onGroupMessage((event) => {
  void handle('group', event.group_id, event, (part) => bot.sendGroupMessage(Number(event.group_id), qqText(part)))
})

log(`角色 QQ 桥接启动：character=${characterId} ws=${cfg.wsUrl} pet=${baseUrl}${apiPath} dry=${dry}`)
if (!(cfg.allow?.private?.length || cfg.allow?.allowAllPrivate || cfg.allow?.groups?.length)) {
  log('⚠️ 白名单为空：不会回复任何人（把主人 QQ 加到 allow.private）')
}

function shutdown() {
  log('收到退出信号，关闭连接')
  try { bot.close?.() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
