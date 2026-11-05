/**
 * 混合检索测试（设计文档 §5.1 / §5.5）：BM25 基础检索、语义重排、图谱扩张、融合权重、缓存。
 *
 * 运行：node tests/search.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSqliteStore } from '../packages/memory-plugin/lib/sqlite.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-search-'))
process.on('exit', () => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* Windows 句柄释放可能滞后 */
  }
})

const log = () => {}
const ctx = { get: () => (...parts) => join(sandbox, ...parts) }
const ref = { engine: null }
const store = createSqliteStore(ctx, log, () => ref.engine?.getSettings() ?? { storage: { backupKeep: 0 } })
const engine = await createEngine({
  store,
  initialSettings: normalizeSettings({}),
  getSettings: () => normalizeSettings({}),
  log,
})
ref.engine = engine

let passed = 0
async function test(title, run) {
  try {
    await run()
    passed += 1
    console.log(`  ok  ${title}`)
  } catch (error) {
    console.error(`  FAIL ${title}`)
    throw error
  }
}

// 造数据：pnpm 相关、缓存相关、图谱相关
const pnpmDoc = await engine.createItem({ layer: 'L5', title: '仓库构建', content: '这个仓库用 pnpm 管理依赖，pnpm 的 workspace 配置在根目录。', tags: ['构建'], importance: 7, ttlDays: 30 }, 'agent')
const cacheDoc = await engine.createItem({ layer: 'L5', title: '缓存说明', content: '缓存 缓存 缓存 的说明，缓存命中率要监控。', tags: ['性能'], importance: 5, ttlDays: 30 }, 'agent')
const otherDoc = await engine.createItem({ layer: 'L5', title: '账号资产', content: '测试账号只保存在本机。', tags: ['资产'], importance: 5, ttlDays: 30 }, 'agent')
const graphDoc = await engine.createItem({ layer: 'L5', title: '无关的图谱节点', content: '这段文字和查询没有任何词面重合。', tags: ['图谱'], importance: 4, ttlDays: 30 }, 'agent')

// 直接插一条关系边：pnpmDoc → graphDoc
store.raw().prepare(
  "INSERT INTO relationships (id, source_id, target_id, edge_type, weight, created_at, metadata) VALUES ('edge-1', ?, ?, 'related_to', 0.9, ?, '{}')",
).run(pnpmDoc.id, graphDoc.id, new Date().toISOString())

await test('BM25 基础检索命中正确条目', async () => {
  const result = await engine.searchItems({ query: 'pnpm workspace' })
  assert.ok(result.total >= 1)
  assert.equal(result.items[0].id, pnpmDoc.id)
  assert.ok(result.items[0].breakdown.fulltext > 0)
  assert.equal(result.breakdown, 'hybrid')
})

await test('词频（tf）高的条目排序更靠前', async () => {
  const result = await engine.searchItems({ query: '缓存' })
  assert.ok(result.total >= 2)
  assert.equal(result.items[0].id, cacheDoc.id, '重复提到"缓存"的条目应排第一')
})

await test('语义分参与融合（breakdown 里有 semantic）', async () => {
  const result = await engine.searchItems({ query: 'pnpm 依赖管理' })
  const hit = result.items.find((item) => item.id === pnpmDoc.id)
  assert.ok(hit !== undefined)
  assert.ok(typeof hit.breakdown.semantic === 'number')
  assert.ok(hit.breakdown.semantic > 0, `语义分应大于 0，实际 ${hit.breakdown.semantic}`)
  assert.ok(hit.breakdown.final > 0)
})

await test('关系图谱会把关联记忆带进结果', async () => {
  const result = await engine.searchItems({ query: 'pnpm', layer: undefined })
  const related = result.items.find((item) => item.id === graphDoc.id)
  assert.ok(related !== undefined, '图谱邻居应出现在结果里')
  assert.ok(related.breakdown.graph > 0, `图谱分应大于 0，实际 ${related.breakdown.graph}`)
})

await test('关掉语义/图谱后只剩全文分', async () => {
  await engine.replaceSettings(normalizeSettings({
    retrieval: { semantic: false, graph: false, weights: { fulltext: 0.4, semantic: 0.4, graph: 0.2 } },
  }))
  try {
    engine.rebuildIndexes()
    const result = await engine.searchItems({ query: 'pnpm' })
    assert.ok(result.items.length >= 1)
    assert.ok(result.items.every((item) => item.breakdown.semantic === 0 && item.breakdown.graph === 0))
  } finally {
    await engine.replaceSettings(normalizeSettings({}))
    engine.rebuildIndexes()
  }
})

await test('融合权重可配置且会自动归一化', async () => {
  await engine.replaceSettings(normalizeSettings({
    retrieval: { weights: { fulltext: 1, semantic: 1, graph: 1 } },
  }))
  try {
    const result = await engine.searchItems({ query: 'pnpm' })
    assert.ok(result.weights !== undefined)
    const total = result.weights.fulltext + result.weights.semantic + result.weights.graph
    assert.ok(Math.abs(total - 1) < 1e-6, `权重应归一化到 1，实际 ${total}`)
    for (const item of result.items) {
      const breakdown = item.breakdown
      const expected = result.weights.fulltext * breakdown.fulltext
        + result.weights.semantic * breakdown.semantic
        + result.weights.graph * breakdown.graph
      assert.ok(Math.abs(breakdown.final - expected) < 0.01, `融合分应与权重一致：${breakdown.final} vs ${expected}`)
    }
  } finally {
    await engine.replaceSettings(normalizeSettings({}))
    engine.rebuildIndexes()
  }
})

await test('相同查询命中缓存', async () => {
  await engine.searchItems({ query: '缓存命中率' })
  const second = await engine.searchItems({ query: '缓存命中率' })
  assert.equal(second.cached, true)
  const stats = engine.searchStats()
  assert.ok(stats.cacheHits >= 1)
  assert.ok(stats.indexedDocs >= 4)
})

await test('分层过滤仍然生效', async () => {
  const result = await engine.searchItems({ query: '缓存', layer: 'L1' })
  assert.equal(result.total, 0)
})

await test('重建索引后仍能检索（向量表重建）', async () => {
  const rebuilt = engine.rebuildIndexes()
  assert.equal(rebuilt.items >= 4, true)
  const result = await engine.searchItems({ query: 'pnpm' })
  assert.ok(result.total >= 1)
})

await test('图谱邻接查询', async () => {
  const neighbors = engine.graphNeighbors(pnpmDoc.id)
  assert.equal(neighbors.length, 1)
  assert.equal(neighbors[0].id, graphDoc.id)
  assert.equal(neighbors[0].edgeType, 'related_to')
})

store.close()
console.log(`\n${passed} 项通过`)

