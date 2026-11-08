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

test('自动建边：同主题条目之间会写上 related 边', () => {
  const state = baseState()
  state.items = [
    {
      ...state.items[0],
      id: 'mem_g1',
      layer: 'L4',
      type: 'memory',
      title: '海鸥桥检修排期',
      content: '海鸥桥检修定在周三凌晨，桥面封半幅，值班表已发。',
      conflicts: [],
    },
    {
      ...state.items[0],
      id: 'mem_g2',
      layer: 'L4',
      type: 'memory',
      title: '周三凌晨桥面封半幅',
      content: '海鸥桥检修周三凌晨封半幅，值班表贴在门卫室，记得带反光背心。',
      conflicts: [],
    },
  ]
  store.write(state)
  const edges = store.raw().prepare("SELECT * FROM relationships WHERE edge_type = 'related'").all()
  assert.ok(edges.length >= 2, '同主题两条之间应建出双向边')
  for (const edge of edges) {
    assert.ok(edge.weight > 0 && edge.weight <= 1, '边权是 idf 加权余弦，落在 0-1')
    assert.notEqual(edge.source_id, edge.target_id, '不该有自环')
    assert.ok(['mem_g1', 'mem_g2'].includes(edge.source_id))
  }
  // 删掉其中一条，重写后边要跟着消失，不能留下悬空的关系。
  const trimmed = store.read()
  trimmed.items = trimmed.items.filter((entry) => entry.id !== 'mem_g2')
  store.write(trimmed)
  const left = store.raw().prepare("SELECT * FROM relationships WHERE edge_type = 'related'").all()
  assert.equal(left.length, 0, '条目删掉后 related 边应被清掉')
  // 还原成基础状态，后面的用例仍按原始条目断言。
  store.write(baseState())
})

test('人工关联：写一条 manual 边，重建自动边后仍在，删掉后消失', () => {
  const state = baseState()
  state.items = [
    { ...state.items[0], id: 'mem_l1', title: '阳台绿萝浇水', content: '绿萝三天浇一次水，别晒正午的太阳。' },
    { ...state.items[0], id: 'mem_l2', title: '地下室除湿机', content: '除湿机每周倒一次水箱，滤网每月洗。' },
  ]
  store.write(state)
  store.linkItems({ sourceId: 'mem_l2', targetId: 'mem_l1' })
  const manual = store.links('mem_l1').filter((entry) => entry.edgeType === 'manual')
  assert.equal(manual.length, 1, '人工边应出现在关联列表里')
  assert.equal(manual[0].id, 'mem_l2')
  assert.ok(manual[0].weight > 0 && manual[0].weight <= 1)
  // 反着再连一次：方向归一，只留一条边
  store.linkItems({ sourceId: 'mem_l1', targetId: 'mem_l2', weight: 0.6 })
  const rows = store.raw().prepare("SELECT * FROM relationships WHERE edge_type = 'manual'").all()
  assert.equal(rows.length, 1, '同一对条目不该有两条人工边')
  assert.equal(rows[0].weight, 0.6)
  // 写一次库触发自动建边整批重建，人工边不能跟着没
  store.write(store.read())
  assert.equal(
    store.raw().prepare("SELECT COUNT(*) AS n FROM relationships WHERE edge_type = 'manual'").get().n,
    1,
    '重建 related 边不该动 manual 边',
  )
  assert.equal(store.unlinkItems({ sourceId: 'mem_l1', targetId: 'mem_l2' }), 1)
  assert.equal(store.links('mem_l1').filter((entry) => entry.edgeType === 'manual').length, 0)
  // 连不存在的条目要报错，不能建出悬空边
  assert.throws(() => store.linkItems({ sourceId: 'mem_l1', targetId: 'mem_missing' }), /不存在/)
  store.write(baseState())
})

test('旧副本写回不会抹平库里的「能回答什么问题」', () => {
  const state = store.read()
  const item = state.items.find((entry) => entry.id === 'mem_a1')
  // 先在库里写上问法（等效于外部脚本 backfill-questions.mjs 直接写库）
  item.questions = ['仓库用什么包管理器', '测试跑什么命令']
  store.write(state)
  assert.deepEqual(store.read().items.find((entry) => entry.id === 'mem_a1').questions, [
    '仓库用什么包管理器',
    '测试跑什么命令',
  ])
  // 插件内存里还是旧副本（questions 为空），回写一次
  const stale = store.read()
  const staleItem = stale.items.find((entry) => entry.id === 'mem_a1')
  staleItem.questions = []
  staleItem.accessCount += 1
  store.write(stale)
  const back = store.read().items.find((entry) => entry.id === 'mem_a1')
  assert.deepEqual(back.questions, ['仓库用什么包管理器', '测试跑什么命令'])
  assert.equal(back.accessCount, staleItem.accessCount)
  // 真带着新问法时照旧覆盖
  const fresh = store.read()
  fresh.items.find((entry) => entry.id === 'mem_a1').questions = ['换新的问法']
  store.write(fresh)
  assert.deepEqual(store.read().items.find((entry) => entry.id === 'mem_a1').questions, ['换新的问法'])
})

test('删除条目会同时清掉关系边', () => {
  const state = store.read()
  state.items = state.items.filter((entry) => entry.id !== 'mem_b2')
  // 引擎删除时会顺手清掉其它条目对它的冲突引用，这里保持一致
  for (const item of state.items) item.conflicts = item.conflicts.filter((id) => id !== 'mem_b2')
  store.write(state)
  const back = store.read()
  assert.equal(back.items.some((entry) => entry.id === 'mem_b2'), false)
  // related 边由条目内容自动重建，这里只要求「被删条目不再出现在任何边上」，
  // 冲突边仍应清空。
  const edges = store.raw().prepare('SELECT * FROM relationships').all()
  assert.equal(edges.filter((edge) => edge.edge_type === 'conflict').length, 0)
  assert.equal(edges.some((edge) => edge.source_id === 'mem_b2' || edge.target_id === 'mem_b2'), false)
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

test('结构化变更审计写入 change_details 并可还原', () => {
  const state = store.read()
  state.audit.push({
    at: new Date().toISOString(),
    action: 'change',
    kind: 'change',
    detail: 'update 笔记 mem_a1',
    actor: 'agent',
    change: {
      operation: 'update', entity: 'memory', itemId: 'mem_a1', title: '构建命令',
      layer: 'L4', notebook: null, changed: ['title'],
      before: { title: '构建命令' }, after: { title: '构建命令（改）' }, reason: 'test',
    },
  })
  store.write(state)
  const row = store.raw().prepare("SELECT target_id, layer, change_details FROM changelog WHERE operation = 'change'").get()
  assert.equal(row.target_id, 'mem_a1')
  assert.equal(row.layer, 'L4')
  const back = store.read().audit.find((entry) => entry.kind === 'change')
  assert.equal(back.change.itemId, 'mem_a1')
  assert.equal(back.change.operation, 'update')
  assert.deepEqual(back.change.changed, ['title'])
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
      layer: 'L5',
      title: 'SQLite 集成',
      content: '引擎直接写进 SQLite，验证启动加载不递归并且能读回。',
      tags: ['集成'],
      importance: 7,
      ttlDays: 30,
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







