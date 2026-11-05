/**
 * SQLite 存储层测试（`node:sqlite`，零依赖）。
 *
 * 覆盖：设计文档 §7.2 的表结构、条目 → memories/events/assets 的分表映射、
 * 重要性 / 保鲜期换算、冲突关系表、审计流水、增量写入、删除、重开持久化、
 * 以及从旧版 JSON 记忆库的一次性迁移。
 *
 * 运行：node tests/sqlite.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DB_FILE, LEGACY_JSON_FILE, createSqliteStore } from '../packages/memory-plugin/lib/sqlite.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-sqlite-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const log = () => {}
const ctx = { get: () => (...parts) => join(sandbox, ...parts) }

let passed = 0
function test(title, run) {
  try {
    run()
    passed += 1
    console.log(`  ok  ${title}`)
  } catch (error) {
    console.error(`  FAIL ${title}`)
    throw error
  }
}

const now = new Date().toISOString()
const baseState = () => ({
  version: 1,
  createdAt: now,
  updatedAt: now,
  settings: { enabled: true, storage: { engine: 'sqlite' } },
  items: [
    {
      id: 'mem_a1', type: 'memory', layer: 'L4', notebook: null,
      title: '构建命令', content: '仓库用 pnpm，测试用 node scripts/check.mjs。',
      tags: ['构建', 'pnpm'], importance: 8, status: 'active', pinned: true,
      ttlDays: null, expiresAt: null,
      source: { kind: 'agent', sessionId: 's1', workspace: null },
      createdAt: now, updatedAt: now, lastAccessAt: now, accessCount: 3, version: 2,
      conflicts: [],
    },
    {
      id: 'mem_b2', type: 'note', layer: 'L5', notebook: 'daily',
      title: '今天做了什么', content: '把存储换成了 SQLite。',
      tags: ['日志'], importance: 5, status: 'active', pinned: false,
      ttlDays: null, expiresAt: null,
      source: { kind: 'user', sessionId: 's1', workspace: null },
      createdAt: now, updatedAt: now, lastAccessAt: now, accessCount: 0, version: 1,
      conflicts: [],
    },
    {
      id: 'mem_c3', type: 'note', layer: 'L4', notebook: 'asset',
      title: '测试账号', content: '只保存在本机的测试账号说明。',
      tags: ['资产'], importance: 6, status: 'active', pinned: false,
      ttlDays: null, expiresAt: null,
      source: { kind: 'user', sessionId: null, workspace: null },
      createdAt: now, updatedAt: now, lastAccessAt: now, accessCount: 1, version: 1,
      conflicts: [],
    },
  ],
  audit: [
    { at: now, action: 'create', detail: 'mem_a1', actor: 'agent' },
  ],
  meta: { writes: 3, searches: 1, lastMaintenance: null },
})

const store = createSqliteStore(ctx, log, () => ({ storage: { engine: 'sqlite', backupKeep: 0 } }))

test('首次写入会建库建表', () => {
  store.write(baseState())
  assert.ok(existsSync(store.path), '数据库文件应已创建')
  const info = store.info()
  assert.equal(info.engine, 'sqlite')
  assert.equal(info.tables.memories, 1, '普通记忆进 memories 表')
  assert.equal(info.tables.events, 1, '日常记事进 events 表')
  assert.equal(info.tables.assets, 1, '资产记事进 assets 表')
  assert.equal(info.tables.changelog, 1)
})

test('memories 表的列与设计文档 §7.2 一致', () => {
  const columns = store.raw().prepare('PRAGMA table_info(memories)').all().map((row) => row.name)
  for (const expected of ['id', 'layer', 'type', 'content', 'metadata', 'created_at', 'updated_at', 'last_accessed', 'access_count', 'importance_score', 'confidence', 'freshness_period', 'status']) {
    assert.ok(columns.includes(expected), `memories 缺少列 ${expected}`)
  }
})

test('读回的条目字段完整且类型正确', () => {
  const state = store.read()
  assert.ok(state !== undefined)
  const item = state.items.find((entry) => entry.id === 'mem_a1')
  assert.equal(item.title, '构建命令')
  assert.equal(item.layer, 'L4')
  assert.equal(item.importance, 8)
  assert.deepEqual(item.tags, ['构建', 'pnpm'])
  assert.equal(item.pinned, true)
  assert.equal(item.accessCount, 3)
  assert.equal(item.version, 2)
  assert.equal(item.source.kind, 'agent')
  const note = state.items.find((entry) => entry.id === 'mem_b2')
  assert.equal(note.notebook, 'daily')
  const asset = state.items.find((entry) => entry.id === 'mem_c3')
  assert.equal(asset.notebook, 'asset')
})

test('设置与元信息存在 config 表里', () => {
  const row = store.raw().prepare("SELECT value FROM config WHERE key = 'settings'").get()
  assert.ok(row.value.includes('"enabled":true'))
  const state = store.read()
  assert.equal(state.settings.enabled, true)
  assert.equal(state.meta.writes, 3)
})

test('冲突写进 relationships 表，读回能还原', () => {
  const state = baseState()
  state.items[0].conflicts = ['mem_b2']
  state.items[1].conflicts = ['mem_a1']
  store.write(state)
  const edges = store.raw().prepare("SELECT * FROM relationships WHERE edge_type = 'conflict'").all()
  assert.equal(edges.length, 2)
  const back = store.read()
  assert.deepEqual(back.items.find((entry) => entry.id === 'mem_a1').conflicts, ['mem_b2'])
})

test('更新条目只改那一行，读回生效', () => {
  const state = store.read()
  const item = state.items.find((entry) => entry.id === 'mem_a1')
  item.title = '构建命令（改）'
  item.importance = 9
  item.version = 3
  item.updatedAt = new Date(Date.now() + 1000).toISOString()
  store.write(state)
  const back = store.read().items.find((entry) => entry.id === 'mem_a1')
  assert.equal(back.title, '构建命令（改）')
  assert.equal(back.importance, 9)
  assert.equal(back.version, 3)
})

test('删除条目会同时清掉关系边', () => {
  const state = store.read()
  state.items = state.items.filter((entry) => entry.id !== 'mem_b2')
  // 引擎删除时会顺手清掉其它条目对它的冲突引用，这里保持一致
  for (const item of state.items) item.conflicts = item.conflicts.filter((id) => id !== 'mem_b2')
  store.write(state)
  const back = store.read()
  assert.equal(back.items.some((entry) => entry.id === 'mem_b2'), false)
  const edges = store.raw().prepare('SELECT * FROM relationships').all()
  assert.equal(edges.length, 0)
})

test('审计日志追加，截断后整表重写', () => {
  const state = store.read()
  state.audit.push({ at: new Date().toISOString(), action: 'update', detail: 'mem_a1', actor: 'user' })
  store.write(state)
  assert.equal(store.raw().prepare('SELECT COUNT(*) AS n FROM changelog').get().n, 2)
  state.audit = state.audit.slice(-1)
  store.write(state)
  assert.equal(store.raw().prepare('SELECT COUNT(*) AS n FROM changelog').get().n, 1)
})

test('关闭后重新打开数据仍在', () => {
  const before = store.read().items.length
  store.close()
  const reopened = createSqliteStore(ctx, log, () => ({ storage: { engine: 'sqlite', backupKeep: 0 } }))
  const state = reopened.read()
  assert.equal(state.items.length, before)
  reopened.close()
})

test('旧版 store.json 会被一次性迁移进 SQLite', () => {
  const legacyDir = mkdtempSync(join(tmpdir(), 'dsh-memory-legacy-'))
  // 旧版 JSON 与数据库在同一目录：<data>/storages/dsh-memory-plugin/
  const legacyDataDir = join(legacyDir, 'storages', 'dsh-memory-plugin')
  mkdirSync(legacyDataDir, { recursive: true })
  writeFileSync(join(legacyDataDir, LEGACY_JSON_FILE), JSON.stringify(baseState()))
  const legacyCtx = { get: () => (...parts) => join(legacyDir, ...parts) }
  const legacyStore = createSqliteStore(legacyCtx, log, () => ({ storage: { engine: 'sqlite', backupKeep: 0 } }))
  try {
    const migrated = legacyStore.read()
    assert.ok(migrated !== undefined, '应能从旧 JSON 迁移出数据')
    assert.equal(migrated.items.length, 3)
    assert.ok(existsSync(legacyStore.path), '迁移后应生成数据库文件')
    assert.equal(legacyStore.read().items.length, 3, '第二次读走的是数据库而不是 JSON')
  } finally {
    legacyStore.close()
    try {
      rmSync(legacyDir, { recursive: true, force: true })
    } catch {
      // Windows 上 SQLite 的句柄释放可能滞后，临时目录交给系统清理
    }
  }
})

await test('引擎直接跑在 SQLite 上（启动加载不递归）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-engine-sqlite-'))
  const engineCtx = { get: () => (...parts) => join(dir, ...parts) }
  const ref = { engine: null }
  const sqliteStore = createSqliteStore(engineCtx, log, () => ref.engine?.getSettings?.() ?? { storage: { backupKeep: 0 } })
  const engine = await createEngine({
    store: sqliteStore,
    initialSettings: normalizeSettings({}),
    getSettings: () => normalizeSettings({}),
    log,
  })
  ref.engine = engine
  try {
    // 这一步就是曾经把栈打爆的地方：读库时要拿设置，设置又触发读库。
    engine.reload()
    const item = await engine.createItem({
      title: 'SQLite 集成',
      content: '引擎直接写进 SQLite，验证启动加载不递归并且能读回。',
      tags: ['集成'],
      importance: 7,
    }, 'agent')
    assert.ok(item.id.startsWith('mem_'))
    assert.equal(sqliteStore.raw().prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1)
    engine.reload()
    const found = await engine.searchItems({ query: 'SQLite' })
    assert.ok(found.total >= 1)
    assert.equal(engine.getSettings().storage.engine, 'auto')
  } finally {
    sqliteStore.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 句柄释放可能滞后
    }
  }
})

test('设置里关闭备份时不产生 .bak 文件', () => {
  const files = []
  for (let index = 1; index <= 3; index += 1) files.push(existsSync(`${store.path}.bak-${index}`))
  assert.deepEqual(files, [false, false, false])
})

store.close()
console.log(`\n${passed} 项通过，数据库：${store.path}`)







