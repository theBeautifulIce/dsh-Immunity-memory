/**
 * 性能基准测试（参考代码2 §9 的落地）。
 *
 * 测量的是真实链路：
 *   Node 控制层 → Go 服务（SQLite + FTS5 + 图谱）→ 原生核心（Rust 批量数学）
 *
 * 用法：
 *   node scripts/benchmark.mjs                       # 默认 2000 条
 *   node scripts/benchmark.mjs --items 10000 --queries 200
 *   node scripts/benchmark.mjs --out docs/性能报告.md  # 同时写报告
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { createGoStore } from '../packages/memory-plugin/lib/go-store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { createNativeCore } from '../packages/memory-plugin/lib/native.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'
import { tokenize } from '../packages/memory-plugin/lib/text.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const ITEMS = Number(flag('items', '2000')) || 2000
const QUERIES = Number(flag('queries', '100')) || 100
const GRAPH_RUNS = Number(flag('graph', '50')) || 50
const OUT = flag('out', '')

const WORK = join(ROOT, '.tmp', `benchmark-${Date.now()}`)
mkdirSync(WORK, { recursive: true })

const TOPICS = [
  ['构建', '这个仓库用 pnpm 管理依赖，构建脚本在 scripts 目录。'],
  ['检索', '全文检索使用 SQLite FTS5，中文按单字和二元组切分。'],
  ['图谱', '记忆之间的关系用 BFS 遍历，相关度按 0.8 衰减。'],
  ['向量', '语义检索把候选向量打包成矩阵批量算余弦相似度。'],
  ['维护', '轮转清理按重要性评分把过期的记忆归档。'],
  ['布局', '设置页分为记忆、记事本、设置、维护四个标签。'],
  ['存储', 'SQLite 使用 WAL 模式，写事务保证索引与数据一致。'],
  ['接口', '本地 HTTP 服务监听回环地址，Node 通过 token 调用。'],
]

function nowIso() {
  return new Date().toISOString()
}

function makeItems(count) {
  const out = []
  const base = Date.now()
  for (let index = 0; index < count; index += 1) {
    const [topic, body] = TOPICS[index % TOPICS.length]
    const created = new Date(base - index * 60_000).toISOString()
    out.push({
      id: `bench_${index}`,
      type: 'memory',
      layer: index % 5 === 0 ? 'L4' : 'L5',
      notebook: null,
      title: `${topic} 说明 ${index}`,
      content: `${body}（第 ${index} 条基准数据）`,
      tags: [topic],
      importance: 5 + (index % 5),
      status: 'active',
      pinned: false,
      ttlDays: null,
      expiresAt: null,
      source: { kind: 'import', sessionId: null, workspace: null },
      createdAt: created,
      updatedAt: created,
      lastAccessAt: created,
      accessCount: 0,
      version: 1,
      conflicts: index < 200 && index % 2 === 0 ? [`bench_${index + 1}`] : [],
    })
  }
  return out
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

const log = () => {}
const ctx = { get: () => (...parts) => join(WORK, ...parts) }
const store = createGoStore(ctx, log, () => ({ storage: { engine: 'go' } }))
await store.ready()
const native = createNativeCore({ log })
const ref = { engine: null }
const engine = await createEngine({
  store,
  native,
  initialSettings: normalizeSettings({}),
  getSettings: () => ref.engine?.getSettings() ?? normalizeSettings({}),
  log,
})
ref.engine = engine

console.log(`== 性能基准（${ITEMS} 条，${QUERIES} 次查询，${GRAPH_RUNS} 次图谱遍历）==`)
const seededAt = Date.now()
const items = makeItems(ITEMS)
await engine.importData({ items, mode: 'merge' }, 'merge')
const seedMs = Date.now() - seededAt

const createTimes = []
for (let index = 0; index < Math.min(200, ITEMS); index += 1) {
  const started = process.hrtime.bigint()
  await engine.createItem({ title: `写入基准 ${index}`, content: `逐条写入的基准数据 ${index}，用于测单条写入延迟。`, tags: ['基准'], ttlDays: 30 }, 'agent')
  createTimes.push(Number(process.hrtime.bigint() - started) / 1e6)
}

const searchTimes = []
const searchNoSemantic = []
for (let index = 0; index < QUERIES; index += 1) {
  const topic = TOPICS[index % TOPICS.length][0]
  const started = process.hrtime.bigint()
  await engine.searchItems({ query: `${topic} ${index % 7}`, limit: 20 })
  searchTimes.push(Number(process.hrtime.bigint() - started) / 1e6)
}
// 语义开关只切换一次：设置落盘也要走一次 HTTP + SQLite 事务，不能算进单次检索。
const currentSettings = engine.getSettings()
await engine.replaceSettings(normalizeSettings({
  ...currentSettings,
  retrieval: { ...currentSettings.retrieval, semantic: false },
}))
for (let index = 0; index < QUERIES; index += 1) {
  const topic = TOPICS[index % TOPICS.length][0]
  const started = process.hrtime.bigint()
  await engine.searchItems({ query: `${topic} ${index % 7}`, limit: 20 })
  searchNoSemantic.push(Number(process.hrtime.bigint() - started) / 1e6)
}
await engine.replaceSettings(normalizeSettings({}))

const graphTimes = []
for (let index = 0; index < GRAPH_RUNS; index += 1) {
  const started = process.hrtime.bigint()
  await store.graphBfs([`bench_${(index % 100) * 2}`], { depth: 2, minWeight: 0.5, maxResults: 50 })
  graphTimes.push(Number(process.hrtime.bigint() - started) / 1e6)
}

// 原生核心批量计算
const DIM = 384
const query = new Float32Array(DIM)
for (let index = 0; index < DIM; index += 1) query[index] = Math.random()
let norm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0))
for (let index = 0; index < DIM; index += 1) query[index] /= norm
const matrix = new Float32Array(1000 * DIM)
for (let index = 0; index < matrix.length; index += 1) matrix[index] = Math.random()
const cosineStart = process.hrtime.bigint()
await native.cosine(query, matrix, 1000, DIM)
const cosineMs = Number(process.hrtime.bigint() - cosineStart) / 1e6

const importanceItems = Array.from({ length: 5000 }, (_, index) => ({
  createdAt: Date.now() / 1000 - index * 3600,
  lastAccessAt: Date.now() / 1000 - index * 60,
  accessCount: index % 10,
  relatedCount: index % 20,
}))
const importanceStart = process.hrtime.bigint()
await native.importance(importanceItems, Date.now() / 1000)
const importanceMs = Number(process.hrtime.bigint() - importanceStart) / 1e6

const dedupeStart = process.hrtime.bigint()
await native.dedupe(Array.from({ length: 2000 }, (_, index) => ({
  id: `d${index}`,
  tokens: [...tokenize(`第 ${index % 50} 类 内容 说明 基准`)],
})), 0.82)
const dedupeMs = Number(process.hrtime.bigint() - dedupeStart) / 1e6

const stats = await store.stats()
const rows = [
  ['批量导入', `${ITEMS} 条`, `${seedMs.toFixed(0)} ms`, `${(ITEMS / (seedMs / 1000)).toFixed(0)} 条/秒`],
  ['单条写入（平均）', '200 次', `${(createTimes.reduce((a, b) => a + b, 0) / createTimes.length).toFixed(2)} ms`, `p95 ${percentile(createTimes, 95).toFixed(2)} ms`],
  ['混合检索（平均）', `${QUERIES} 次`, `${(searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length).toFixed(2)} ms`, `p95 ${percentile(searchTimes, 95).toFixed(2)} ms`],
  ['检索（关语义）', `${QUERIES} 次`, `${(searchNoSemantic.reduce((a, b) => a + b, 0) / searchNoSemantic.length).toFixed(2)} ms`, `p95 ${percentile(searchNoSemantic, 95).toFixed(2)} ms`],
  ['图谱 BFS（深度 2）', `${GRAPH_RUNS} 次`, `${(graphTimes.reduce((a, b) => a + b, 0) / graphTimes.length).toFixed(2)} ms`, `p95 ${percentile(graphTimes, 95).toFixed(2)} ms`],
  ['批量余弦（Rust）', '1000 × 384 维', `${cosineMs.toFixed(2)} ms`, `${(1000 / (cosineMs / 1000)).toFixed(0)} 对/秒`],
  ['批量重要性（Rust）', '5000 条', `${importanceMs.toFixed(2)} ms`, `${(5000 / (importanceMs / 1000)).toFixed(0)} 条/秒`],
  ['批量去重（Rust）', '2000 条', `${dedupeMs.toFixed(2)} ms`, `${(2000 / (dedupeMs / 1000)).toFixed(0)} 条/秒`],
]

const system = spawnSync('node', ['-p', 'process.versions'], { encoding: 'utf8' })
const versions = (() => {
  try {
    return JSON.parse(system.stdout)
  } catch {
    return {}
  }
})()

console.log('')
for (const row of rows) console.log(row[0].padEnd(22), row[1].padEnd(16), row[2].padEnd(12), row[3])
console.log('')
console.log(`数据库：${store.path}`)
console.log(`Go 服务：v${store.service.version} · pid ${store.service.pid}`)
console.log(`原生核心：${native.health().version ?? 'JS 兜底'}`)
console.log(`行数：${JSON.stringify(stats)}`)

if (OUT !== '') {
  const report = [
    '# 性能报告',
    '',
    `生成时间：${nowIso()}`,
    '',
    '## 测试环境',
    '',
    `- Node：${versions.node ?? process.version}`,
    `- V8：${versions.v8 ?? '-'}`,
    `- 平台：${process.platform}-${process.arch}`,
    `- Go 服务：v${store.service.version}`,
    `- Rust 核心：${native.health().version ?? '未启用（JS 兜底）'}`,
    `- 数据集：${ITEMS} 条记忆（含 200 条互相冲突的关系边）`,
    '',
    '## 结果',
    '',
    '| 场景 | 规模 | 耗时 | 吞吐 / 分位数 |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`),
    '',
    '## 说明',
    '',
    '- 检索链路：Node → 本地 HTTP → Go 服务 → SQLite FTS5（bm25）+ 向量余弦 + 图谱 BFS + 三路融合。',
    '- 批量数学（余弦 / 重要性 / 去重）由 Rust 原生核心完成；不可用时自动退回 JS。',
    '- 单条写入包含一次 HTTP 往返与一次 SQLite WAL 事务。',
    '- 数字随机器不同而不同，用 `node scripts/benchmark.mjs` 可复测。',
    '',
  ].join('\n')
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  const { writeFileSync } = await import('node:fs')
  const target = join(ROOT, OUT)
  writeFileSync(target, report)
  console.log(`\n报告已写入 ${target}`)
}

await store.close()
native.close()
try {
  rmSync(WORK, { recursive: true, force: true })
} catch {
  // Windows 句柄释放可能滞后
}

