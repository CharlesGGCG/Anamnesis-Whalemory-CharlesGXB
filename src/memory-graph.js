// src/memory-graph.js —— 记忆图谱适配层（wrap vendored CJS 引擎）
//
// 对话 → 知识图谱 → 向量召回 → 遗忘曲线。引擎本体在 src/memory-graph-engine/
// （MIT，源自 feiyuos-memory-graph，零依赖、纯 Node）。
//
// provider 三种：
//   - 'surfcore'：chat（抽取）走 SiliconFlow，embed（向量）走 surfcore 本地 bge-m3 服务。
//   - 'openai'  ：任何 OpenAI 兼容端点（chat + embed 同一个 baseUrl）。
//   - 'offline' ：内置规则 + n-gram，零外部依赖，仅用于验证。
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { embedTexts, normalizeVectorMemoryConfig } from './vector-memory.js'
import { memoryPathsFor, readCurrentCharacter } from './character-persona.js'

const require = createRequire(import.meta.url)
const { MemoryEngine, providers } = require('./memory-graph-engine/index.js')

function l2norm(vector, dimension) {
  const dim = Number(dimension) || (Array.isArray(vector) ? vector.length : 0)
  const out = new Float32Array(Math.max(0, dim))
  if (!dim) return out
  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += Number(vector[i]) * Number(vector[i])
  norm = Math.sqrt(norm)
  if (!norm) return out
  for (let i = 0; i < dim; i += 1) out[i] = Number(vector[i]) / norm
  return out
}

/** chat → SiliconFlow；embed → SiliconFlow（默认）或本地 bge-m3（`embed: 'local'`）。 */
function surfcoreProvider(cfg = {}) {
  const sf = cfg.siliconflow && typeof cfg.siliconflow === 'object' ? cfg.siliconflow : {}
  const baseUrl = String(sf.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
  const apiKey = String(sf.apiKey || '')
  const chatModel = String(sf.chatModel || 'deepseek-ai/DeepSeek-V3')
  const embedModel = String(sf.embedModel || 'BAAI/bge-m3')
  const embedMode = String(cfg.embed || 'siliconflow') === 'local' ? 'local' : 'siliconflow'
  const vectorCfg = normalizeVectorMemoryConfig(cfg.vectorMemory || {})
  const dim = Number(cfg.dim) || 1024

  return {
    name: `surfcore(siliconflow-chat + ${embedMode}-embed)`,
    dim,

    async chat(messages, o = {}) {
      if (!apiKey) throw new Error('缺 SiliconFlow API Key：设 SILICONFLOW_API_KEY 或写进 memory-graph.config.json')
      const body = { model: o.model || chatModel, messages, temperature: 0.3, stream: false }
      if (o.json) body.response_format = { type: 'json_object' }
      if (o.maxTokens) body.max_tokens = o.maxTokens
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`SiliconFlow LLM HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`)
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('SiliconFlow 响应缺少 choices[0].message.content')
      return content
    },

    async embed(texts) {
      const list = Array.isArray(texts) ? texts : [texts]
      if (embedMode === 'local') {
        const { vectors, dimension } = await embedTexts({ config: vectorCfg, texts: list })
        return vectors.map((v) => l2norm(v, dimension))
      }
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: embedModel, input: list, encoding_format: 'float' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`SiliconFlow embed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`)
      const rows = [...(data?.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (rows.length !== list.length) throw new Error('SiliconFlow embed 返回数量不符')
      return rows.map((r) => l2norm(r.embedding, dim))
    },
  }
}

export function providerFromConfig(cfg = {}) {
  const kind = String(cfg && cfg.provider ? cfg.provider : 'offline')
  if (kind === 'surfcore') return surfcoreProvider(cfg)
  if (kind === 'openai') {
    return providers.openai({
      baseUrl: String(cfg.baseUrl ?? ''),
      apiKey: String(cfg.apiKey ?? ''),
      chatModel: String(cfg.chatModel || 'deepseek-chat'),
      embedModel: String(cfg.embedModel || 'bge-m3'),
      dim: Number(cfg.dim) || 1024,
      ...(cfg.headers && typeof cfg.headers === 'object' ? { headers: cfg.headers } : {}),
    })
  }
  return providers.offline()
}

/** 记忆图谱配置：~/.dsh/surfcore/memory-graph.config.json，API Key 可用 env 覆盖。 */
export function loadMemoryGraphConfig() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'surfcore', 'memory-graph.config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  if (!cfg || typeof cfg !== 'object') cfg = {}
  if (cfg.siliconflow && typeof cfg.siliconflow === 'object') {
    cfg.siliconflow.apiKey = process.env.SILICONFLOW_API_KEY || cfg.siliconflow.apiKey || ''
  } else {
    cfg.siliconflow = { apiKey: process.env.SILICONFLOW_API_KEY || '', baseUrl: '', chatModel: '' }
  }
  cfg.configFile = file
  return cfg
}

export async function openMemoryGraph({ dir, provider, persona = {}, batchSize = 2 } = {}) {
  const engine = await MemoryEngine.open({
    dir: String(dir ?? ''),
    provider: providerFromConfig(provider),
    persona: {
      personaName: String(persona.personaName || '小鲸鱼'),
      genderTerm: String(persona.genderTerm || '主人'),
    },
    batchSize: Number(batchSize) || 2,
  })
  return {
    enqueue: (turn) => engine.enqueue(turn),
    flush: () => engine.flush(),
    recall: (text) => engine.recall(text),
    close: () => engine.close(),
    engine,
  }
}

// 懒加载：按「数据目录」分别缓存引擎（插件进程 / 桥接进程各自一份）。
// 默认（characterId 为空）用全局目录；非当前角色用 characters/<id>/memory-graph，
// 避免小C 和鲸鱼的记忆混在一张图里。
const _singletons = new Map()
export async function getMemoryGraph(characterId = '') {
  const cfg = loadMemoryGraphConfig()
  const baseDir = String(cfg.dir || '').trim() || path.join(os.homedir(), '.dsh', 'surfcore', 'memory-graph')
  const activeId = readCurrentCharacter()?.id || ''
  const dir = !characterId || characterId === activeId
    ? baseDir
    : path.join(path.dirname(memoryPathsFor(characterId).dir), 'memory-graph')
  if (_singletons.has(dir)) return _singletons.get(dir)
  const engine = await openMemoryGraph({
    dir,
    provider: cfg,
    persona: { personaName: String(cfg.personaName || '小鲸鱼'), genderTerm: String(cfg.genderTerm || '主人') },
    batchSize: Number(cfg.batchSize) || 2,
  })
  _singletons.set(dir, engine)
  return engine
}

/** 召回并渲染成提示词块；任何失败都退化成空串（记忆是锦上添花，坏掉不报错）。 */
export async function graphRecallBlock(text, { maxChars = 600, characterId = '' } = {}) {
  try {
    const g = await getMemoryGraph(characterId)
    const { promptText } = await g.recall(text)
    const s = String(promptText || '').trim()
    if (!s) return ''
    return s.length > maxChars ? `${s.slice(0, Math.max(0, maxChars - 1))}…` : s
  } catch { return '' }
}

export { providers }
