// 直播读弹幕：运维命令（调本机 pet-api，不直接连 B站）
//
//   node live.mjs status
//   node live.mjs start | stop
//   node live.mjs test --author 晚风 --text "晚上好"
//
// 需要 DSH 在跑（插件已加载 live 服务）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const host = JSON.parse(fs.readFileSync(path.join(HOME, 'surfcore', 'pet', 'host.json'), 'utf8'))
const base = String(host.baseUrl || '').replace(/\/+$/, '') + String(host.api || '/dsh-surfcore/pet-api')

const argv = process.argv.slice(2)
const cmd = argv[0] || 'status'
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true)
}

async function post(suffix, body = {}) {
  const res = await fetch(`${base}${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pet-token': host.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  return res.json()
}

if (cmd === 'status') {
  const res = await fetch(`${base}/live/status`, { headers: { 'x-pet-token': host.token }, signal: AbortSignal.timeout(8000) })
  const data = await res.json()
  console.log(JSON.stringify(data, null, 2))
} else if (cmd === 'start' || cmd === 'stop') {
  console.log(JSON.stringify(await post(`/live/${cmd}`), null, 2))
} else if (cmd === 'test') {
  const r = await post('/live/test', { author: String(args.get('author') || '测试观众'), text: String(args.get('text') || '主播晚上好') })
  console.log(JSON.stringify(r, null, 2))
} else {
  console.error('用法：status | start | stop | test [--author 名 --text 内容]')
  process.exit(2)
}
