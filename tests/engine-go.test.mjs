/**
 * 引擎跑在 Go 服务上的端到端测试：
 *   createEngine → Go 服务（SQLite + FTS5 + 图谱）→ 检索 / 写入 / 维护
 *
 * 前置：node scripts/build-go.mjs
 * 运行：node tests/engine-go.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGoStore } from '../packages/memory-plugin/lib/go-store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORK = join(ROOT, '.tmp', `engine-go-test-${Date.now()}`)
mkdirSync(dirname(WORK), { recursive: true })

const log = () => {}
const ctx = { get: () => (...parts) => join(WORK, ...parts) }
const store = createGoStore(ctx, log, () => ({ storage: { engine: 'go' } }))
await store.ready()

const ref = { engine: null }
const engine = await createEngine({
  store,
  initialSettings: normalizeSettings({}),
  getSettings: () => ref.engine?.getSettings() ?? normalizeSettings({}),
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

try {
  let firstId = ''

  await test('创建条目会写进 Go 服务的 SQLite', async () => {
    const item = await engine.createItem({
      title: 'Go 服务集成',
      content: '这条记忆通过 Go 服务写入 SQLite，并由 FTS5 建立全文索引。',
      tags: ['集成', 'go'],
      importance: 8,
      ttlDays: 30,
    }, 'agent')
    assert.ok(item.id.startsWith('mem_'))
    firstId = item.id
    const stats = await store.stats()
    assert.ok(stats.memories >= 1)
    assert.ok(stats.ftsRows >= 1)
    assert.ok(stats.vectors >= 1)
    assert.ok(existsSync(store.path), `数据库应存在：${store.path}`)
  })

  await test('检索走 Go 的 FTS5 并带 breakdown', async () => {
    const result = await engine.searchItems({ query: 'FTS5 全文索引' })
    assert.ok(result.total >= 1, `应命中，实际 ${JSON.stringify(result)}`)
    assert.equal(result.items[0].id, firstId)
    assert.equal(result.breakdown, 'go')
    assert.ok(result.items[0].breakdown.fulltext > 0)
  })

  await test('更新条目后 Go 侧能读到新内容', async () => {
    const updated = await engine.updateItem(firstId, { title: 'Go 服务集成（改）', importance: 9, ttlDays: 30 }, 'user')
    assert.equal(updated.title, 'Go 服务集成（改）')
    const snapshot = await store.load()
    const saved = snapshot.items.find((item) => item.id === firstId)
    assert.equal(saved.title, 'Go 服务集成（改）')
    assert.equal(saved.importance, 9)
  })

  await test('冲突关系写进 Go 的关系表并参与图谱', async () => {
    const left = await engine.createItem({ layer: 'L2', title: '缓存策略 A', content: '缓存统一放 Redis，过期 30 分钟。', ttlDays: 30 }, 'agent')
    const right = await engine.createItem({ layer: 'L2', title: '缓存策略 A', content: '缓存统一放 Redis，过期 30 分钟。', ttlDays: 30 }, 'agent')
    const graph = await store.graphBfs([left.id], { depth: 1, minWeight: 0.5, maxResults: 10 })
    const ids = graph.nodes.map((node) => node.id)
    assert.ok(ids.includes(right.id), `图谱应包含冲突邻居：${ids}`)
  })

  await test('维护任务（去重）能跑通 Go 路径', async () => {
    const report = await engine.runMaintenance({ tasks: ['dedupe', 'reflect'] })
    assert.equal(report.tasks.length, 2)
    assert.ok(report.totals.total >= 3)
  })

  await test('删除条目会同步清掉 Go 侧索引', async () => {
    const result = await engine.deleteItems([firstId], 'user')
    assert.equal(result.deleted, 1)
    const search = await engine.searchItems({ query: 'FTS5 全文索引' })
    assert.equal(search.items.some((item) => item.id === firstId), false)
    const stats = await store.stats()
    assert.ok(stats.memories >= 2)
  })

  await test('设置写进 Go 的 config 表', async () => {
    await engine.replaceSettings(normalizeSettings({ ui: { pageSize: 40 } }))
    const snapshot = await store.load()
    assert.equal(snapshot.settings.ui.pageSize, 40)
  })

  await test('备份接口可用', async () => {
    const backup = await store.backup('test')
    assert.ok(existsSync(backup.path))
    const list = await store.listBackups()
    assert.ok(list.length >= 1)
  })

  console.log(`\n${passed} 项通过`)
} finally {
  await store.close()
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // Windows 句柄释放可能滞后
  }
}
