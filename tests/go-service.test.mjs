/**
 * Go 服务集成测试：直接拉起 memory-service 二进制，验证写入 / FTS 检索 / 图谱 / 备份。
 *
 * 前置：先运行 node scripts/build-go.mjs
 * 运行：node tests/go-service.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BINARY = join(ROOT, 'packages', 'memory-plugin', 'bin', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, process.platform === 'win32' ? 'memory-service.exe' : 'memory-service')
const WORK = join(ROOT, '.tmp', `go-service-test-${Date.now()}`)
const DB = join(WORK, 'memory.sqlite3')
const TOKEN = 'test-token'

if (!existsSync(BINARY)) {
  console.error(`✗ 缺少 Go 服务二进制：${BINARY}\n  先运行 node scripts/build-go.mjs`)
  process.exit(1)
}
mkdirSync(dirname(DB), { recursive: true })

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

const child = spawn(BINARY, ['-db', DB, '-token', TOKEN], { stdio: ['ignore', 'pipe', 'pipe'] })
let port = 0
const stderr = []
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => stderr.push(String(chunk)))

await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error(`启动超时：${stderr.join('')}`)), 15000)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const line = buffer.split('\n')[0]
    if (line.trim() === '') return
    clearTimeout(timer)
    const handshake = JSON.parse(line)
    port = handshake.port
    resolve()
  })
  child.on('exit', (code) => reject(new Error(`服务提前退出 code=${code}：${stderr.join('')}`)))
})

const base = `http://127.0.0.1:${port}`
async function api(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-memory-token': TOKEN },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json()
  if (payload.ok !== true) throw new Error(`${path} 失败：${JSON.stringify(payload)}`)
  return payload
}

const now = new Date().toISOString()
function memory(id, title, content, extra = {}) {
  return {
    id, type: 'memory', layer: 'L5', notebook: null, title, content,
    tags: [], importance: 7, status: 'active', pinned: false,
    ttlDays: null, expiresAt: null,
    source: { kind: 'agent', sessionId: 's1', workspace: null },
    createdAt: now, updatedAt: now, lastAccessAt: now, accessCount: 0, version: 1,
    conflicts: [], ...extra,
  }
}

try {
  await test('批量写入与快照读取', async () => {
    await api('/items/upsert', {
      items: [
        memory('m1', '仓库构建', '这个仓库用 pnpm 管理依赖，workspace 在根目录。', { tags: ['构建'] }),
        memory('m2', '缓存说明', '缓存 缓存 的命中率要监控。', { tags: ['性能'], importance: 5 }),
        {
          ...memory('n1', '今日记录', '把存储换成了 SQLite。', { type: 'note', notebook: 'daily', layer: 'L5' }),
        },
      ],
    })
    const snapshot = await api('/snapshot')
    assert.equal(snapshot.state.items.length, 3)
    const stats = await api('/stats')
    assert.equal(stats.stats.memories, 2)
    assert.equal(stats.stats.events, 1)
    assert.equal(stats.stats.vectors, 3)
    assert.equal(stats.stats.ftsRows, 3)
    assert.equal(stats.integrity.ok, true)
  })

  await test('FTS5 全文检索（中文二元组）', async () => {
    const result = await api('/search', {
      query: 'pnpm 依赖', limit: 5,
      weights: { fulltext: 0.4, semantic: 0.4, graph: 0.2 },
      semantic: false, graph: false,
    })
    assert.ok(result.hits.length >= 1)
    assert.equal(result.hits[0].id, 'm1')
    assert.ok(result.hits[0].breakdown.fulltext > 0)
    const chinese = await api('/search', { query: '缓存', limit: 5, semantic: false, graph: false })
    assert.equal(chinese.hits[0].id, 'm2')
  })

  await test('语义分参与融合（breakdown.semantic）', async () => {
    const result = await api('/search', {
      query: '仓库依赖管理', limit: 5,
      weights: { fulltext: 0.4, semantic: 0.4, graph: 0.2 },
      semantic: true, graph: false,
    })
    const hit = result.hits.find((entry) => entry.id === 'm1')
    assert.ok(hit !== undefined)
    assert.ok(hit.breakdown.semantic > 0, `语义分应大于 0：${JSON.stringify(hit)}`)
  })

  await test('关系图谱 BFS 带边权衰减', async () => {
    await api('/items/upsert', {
      items: [memory('m1', '仓库构建', '这个仓库用 pnpm 管理依赖，workspace 在根目录。', { tags: ['构建'], conflicts: ['m2'] })],
    })
    const graph = await api('/graph/bfs', { seeds: ['m1'], depth: 2, minWeight: 0.5, maxResults: 10 })
    const ids = graph.nodes.map((node) => node.id)
    assert.ok(ids.includes('m1') && ids.includes('m2'), `图谱应包含 m1/m2：${ids}`)
    const m2 = graph.nodes.find((node) => node.id === 'm2')
    assert.equal(m2.depth, 1)
    assert.ok(m2.relevance <= 1)
  })

  await test('写入后自动建 related 边（不需要手动指定冲突）', async () => {
    await api('/items/upsert', {
      items: [
        memory('g1', '海鸥桥检修排期', '海鸥桥检修定在周三凌晨，桥面封半幅，值班表已发。'),
        memory('g2', '周三凌晨桥面封半幅', '海鸥桥检修周三凌晨封半幅，值班表贴在门卫室，记得带反光背心。'),
      ],
    })
    const graph = await api('/graph/bfs', { seeds: ['g1'], depth: 1, minWeight: 0.2, maxResults: 10 })
    const ids = graph.nodes.map((node) => node.id)
    assert.ok(ids.includes('g2'), `同主题条目应被 related 边连上：${ids}`)
    const edge = graph.edges.find((entry) => (entry.source === 'g1' && entry.target === 'g2')
      || (entry.source === 'g2' && entry.target === 'g1'))
    assert.ok(edge !== undefined, `应存在 g1↔g2 的边：${JSON.stringify(graph.edges)}`)
    assert.equal(edge.edgeType, 'related')
    assert.ok(edge.weight > 0 && edge.weight <= 1)
  })

  await test('问法随条目入库，旧副本重写时不被抹掉', async () => {
    const ask = ['灯箱现在到哪一步了']
    await api('/items/upsert', {
      items: [{ ...memory('q1', '灯箱验收', '灯箱验收卡在物业电路确认，等周四回话。'), questions: ask }],
    })
    let snapshot = await api('/snapshot')
    let stored = snapshot.state.items.find((item) => item.id === 'q1')
    assert.deepEqual(stored.questions, ask, '问法应写进元数据并读得回来')
    // 旧副本（内存里没有问法）再次写入同一条，不能把库里的问法抹平
    await api('/items/upsert', {
      items: [memory('q1', '灯箱验收', '灯箱验收卡在物业电路确认，等周四回话。')],
    })
    snapshot = await api('/snapshot')
    stored = snapshot.state.items.find((item) => item.id === 'q1')
    assert.deepEqual(stored.questions, ask, '不带问法的重写不应清空已有问法')
  })

  await test('人工关联边：能写、能列、重建自动边后还在、能删', async () => {
    await api('/items/upsert', {
      items: [
        memory('l1', '阳台绿萝浇水', '绿萝三天浇一次水，别晒正午的太阳。'),
        memory('l2', '地下室除湿机', '除湿机每周倒一次水箱，滤网每月洗。'),
      ],
    })
    const created = await api('/links/upsert', { sourceId: 'l2', targetId: 'l1' })
    assert.equal(created.link.edgeType, 'manual', '人工边单独一个类型')
    assert.equal(created.link.id, 'l1', '返回的是对面那一端')
    assert.ok(created.link.weight > 0 && created.link.weight <= 1)
    // 反着再连一次：方向归一，同一对条目只留一条边
    await api('/links/upsert', { sourceId: 'l1', targetId: 'l2', weight: 0.6 })
    const listed = await api('/links/list', { id: 'l1' })
    const manual = listed.links.filter((entry) => entry.edgeType === 'manual')
    assert.equal(manual.length, 1, '同一对条目不该出现两条人工边')
    assert.equal(manual[0].id, 'l2')
    assert.equal(manual[0].weight, 0.6)
    // 再写一次条目会触发自动建边重建，人工边不能被清掉
    await api('/items/upsert', {
      items: [memory('l1', '阳台绿萝浇水', '绿萝三天浇一次水，别晒正午的太阳。', { version: 2 })],
    })
    const again = await api('/links/list', { id: 'l1' })
    assert.equal(again.links.filter((entry) => entry.edgeType === 'manual').length, 1, '重建自动边不该动人工边')
    const removed = await api('/links/delete', { sourceId: 'l1', targetId: 'l2' })
    assert.equal(removed.removed, 1)
    const after = await api('/links/list', { id: 'l1' })
    assert.equal(after.links.filter((entry) => entry.edgeType === 'manual').length, 0)
    // 连不存在的条目要明确报错，不能悄悄建出一条悬空边
    const bad = await fetch(`${base}/links/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-memory-token': TOKEN },
      body: JSON.stringify({ sourceId: 'l1', targetId: 'nope' }),
    })
    assert.equal((await bad.json()).ok, false)
    await api('/items/delete', { ids: ['l1', 'l2'] })
  })

  await test('过滤条件（分层 / 类型）', async () => {
    const onlyNotes = await api('/search', {
      query: 'SQLite', limit: 5, semantic: false, graph: false,
      filters: { type: 'note' },
    })
    assert.ok(onlyNotes.hits.every((hit) => hit.id === 'n1'))
    const noMatch = await api('/search', {
      query: 'pnpm', limit: 5, semantic: false, graph: false, filters: { layer: 'L1' },
    })
    assert.equal(noMatch.hits.length, 0)
  })

  await test('配置持久化与重读', async () => {
    await api('/config', { key: 'settings', value: { enabled: true, prompt: { topN: 3 } } })
    const snapshot = await api('/snapshot')
    assert.equal(snapshot.state.settings.prompt.topN, 3)
  })

  await test('备份与列表', async () => {
    const created = await api('/backup', { tag: 'test' })
    assert.ok(existsSync(created.backup.path))
    const list = await api('/backups')
    assert.ok(list.backups.length >= 1)
  })

  await test('审计日志追加', async () => {
    await api('/audit/append', { entries: [{ at: now, action: 'create', detail: 'm1', actor: 'agent' }] })
    const snapshot = await api('/snapshot')
    assert.ok(snapshot.state.audit.some((entry) => entry.action === 'create'))
  })

  await test('结构化变更审计写入 changelog 并可读回', async () => {
    await api('/audit/append', {
      entries: [{
        at: now,
        action: 'change',
        kind: 'change',
        detail: 'update 记忆 m1',
        actor: 'agent',
        change: {
          operation: 'update', entity: 'memory', itemId: 'm1', title: '构建缓存',
          layer: 'L4', notebook: null, changed: ['title'],
          before: { title: '构建缓存' }, after: { title: '构建缓存（新）' }, reason: 'test',
        },
      }],
    })
    const snapshot = await api('/snapshot')
    const entry = snapshot.state.audit.find((candidate) => candidate.kind === 'change')
    assert.equal(entry.change.itemId, 'm1')
    assert.equal(entry.change.layer, 'L4')
    assert.equal(entry.change.changed[0], 'title')
  })

  await test('删除条目会清掉索引', async () => {
    const before = await api('/stats')
    await api('/items/delete', { ids: ['m2'] })
    const stats = await api('/stats')
    assert.equal(stats.stats.memories, before.stats.memories - 1)
    assert.equal(stats.stats.vectors, before.stats.vectors - 1)
    const search = await api('/search', { query: '缓存', limit: 5, semantic: false, graph: false })
    assert.equal(search.hits.some((hit) => hit.id === 'm2'), false, '被删条目不应再被检索到')
  })

  await test('拒绝错误 token', async () => {
    const response = await fetch(`${base}/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-memory-token': 'wrong' },
      body: '{}',
    })
    assert.equal(response.status, 403)
  })

  await test('Node 旧库（版本号冲突）被 Go 接管', async () => {
    // 回归：Node 回退层早期建的 schema_migrations 只有 version/applied_at。
    // Go 迁移若直接 INSERT description 会失败，服务起不来、插件静默退回 Node SQLite。
    const { createSqliteStore, loadSqlite } = await import('../packages/memory-plugin/lib/sqlite.js')
    const legacyDir = join(WORK, 'legacy')
    mkdirSync(legacyDir, { recursive: true })
    const legacyPath = join(legacyDir, 'memory.sqlite3')
    const nodeStore = createSqliteStore({ get: () => undefined }, () => {}, () => ({ storage: { dir: legacyDir } }))
    nodeStore.write({ items: [], settings: {}, meta: {}, createdAt: now })
    nodeStore.close()

    const raw = new (loadSqlite().DatabaseSync)(legacyPath)
    const columns = raw.prepare('PRAGMA table_info(schema_migrations)').all().map((row) => row.name)
    if (columns.includes('description')) raw.exec('ALTER TABLE schema_migrations DROP COLUMN description')
    raw.close()

    const legacy = spawn(BINARY, ['-db', legacyPath, '-token', 'legacy-token'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const legacyPort = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('旧库启动超时')), 15000)
      legacy.stdout.setEncoding('utf8')
      legacy.stdout.on('data', (chunk) => {
        buffer += chunk
        const line = buffer.split('\n')[0]
        if (line.trim() === '') return
        clearTimeout(timer)
        resolve(JSON.parse(line).port)
      })
      legacy.on('exit', (code) => reject(new Error(`旧库服务提前退出 code=${code}`)))
    })
    try {
      const response = await fetch(`http://127.0.0.1:${legacyPort}/health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-memory-token': 'legacy-token' },
        body: '{}',
      })
      const payload = await response.json()
      assert.equal(payload.ok, true, JSON.stringify(payload))
      assert.ok(payload.stats, '健康检查应带统计数据')
      assert.ok(payload.stats.memories >= 0)
    } finally {
      legacy.kill()
      await new Promise((resolve) => {
        if (legacy.exitCode !== null) return resolve()
        legacy.once('exit', resolve)
        setTimeout(resolve, 2000)
      })
    }
  })

  console.log(`\n${passed} 项通过`)
} finally {
  child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve)
    setTimeout(resolve, 2000)
  })
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // Windows 句柄释放可能滞后
  }
}

