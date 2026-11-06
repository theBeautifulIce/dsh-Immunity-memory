/**
 * 宿主接口（lib/api.js）的端到端测试：用真实 http 服务 + 真实引擎，模拟客户端调用。
 *
 * 运行：node tests/api.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { API_PATH, LEGACY_API_PATH, mountApi } from '../packages/memory-plugin/lib/api.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-api-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const log = () => {}
const ctx = { get: () => (name) => join(sandbox, name) }
const ref = { engine: null }
const store = createStore(ctx, log, () => ref.engine?.getSettings() ?? normalizeSettings({}))
const engine = await createEngine({ store, initialSettings: normalizeSettings({}), getSettings: () => normalizeSettings({}), log })
ref.engine = engine

const routes = []
const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}
mountApi(fakeWebServer, engine, log)
assert.equal(routes.length, 1)
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, API_PATH)

const server = createServer((req, res) => routes[0].handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = `http://127.0.0.1:${port}${API_PATH}`

async function call(method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: params ?? {} }),
  })
  const body = await response.json()
  return { status: response.status, body }
}

/** 用原生 http 发请求，才能伪造 Host 头。 */
function rawPost(headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      path: API_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

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
  await test('bootstrap 一次拿到设置、表单元数据与统计', async () => {
    const { status, body } = await call('bootstrap')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.value.enabled, true)
    assert.ok(Array.isArray(body.value.schema) && body.value.schema.length >= 8)
    assert.equal(body.value.stats.total, 0)
    assert.ok(body.value.toolNames.includes('memory_search'))
    assert.ok(typeof body.value.storage.path === 'string')
  })

  await test('mountApi 支持自定义路径（旧前缀兼容）', async () => {
    const seen = []
    const stub = { register(route) { seen.push(route); return () => {} } }
    mountApi(stub, engine, log, { path: LEGACY_API_PATH })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].path, LEGACY_API_PATH)
    assert.equal(seen[0].kind, 'prefix')
    assert.notEqual(API_PATH, LEGACY_API_PATH)
  })

  let createdId = ''
  await test('items.create 写入并返回完整条目', async () => {
    const { body } = await call('items.create', {
      title: '接口测试记忆',
      content: '这条记忆由接口测试写入，用来验证设置页与工具共用同一份数据。',
      tags: ['测试'],
      importance: 6,
      ttlDays: 30,
    })
    assert.equal(body.ok, true)
    assert.ok(body.value.item.id.startsWith('mem_'))
    createdId = body.value.item.id
  })

  await test('items.list 能读到刚写入的条目，并按类型过滤', async () => {
    const { body } = await call('items.list', { type: 'memory', status: 'usable' })
    assert.equal(body.value.total, 1)
    assert.equal(body.value.items[0].id, createdId)
    const notes = await call('items.list', { type: 'note' })
    assert.equal(notes.body.value.total, 0)
  })

  await test('items.search 命中中文关键词', async () => {
    const { body } = await call('items.search', { query: '接口测试' })
    assert.equal(body.value.total, 1)
    assert.ok(body.value.items[0].score > 0)
  })

  await test('items.update 修改标题，版本号递增', async () => {
    const { body } = await call('items.update', { id: createdId, patch: { title: '接口测试记忆（改）', ttlDays: 30 } })
    assert.equal(body.value.item.title, '接口测试记忆（改）')
    assert.equal(body.value.item.version, 2)
  })

  await test('items.bulk 置顶与取消置顶', async () => {
    const pinned = await call('items.bulk', { ids: [createdId], action: 'pin' })
    assert.equal(pinned.body.value.changed, 1)
    assert.equal(engine.getItem(createdId).pinned, true)
    await call('items.bulk', { ids: [createdId], action: 'unpin' })
    assert.equal(engine.getItem(createdId).pinned, false)
  })

  await test('settings.save 只落盘合法字段', async () => {
    const { body } = await call('settings.save', { patch: { ui: { pageSize: 55 }, bogus: 1 } })
    assert.equal(body.value.settings.ui.pageSize, 55)
    assert.equal(engine.getSettings().ui.pageSize, 55)
    await call('settings.save', { patch: { ui: { pageSize: 20 } } })
  })

  await test('settings.reset 恢复默认', async () => {
    await call('settings.save', { patch: { retrieval: { defaultLimit: 3 } } })
    const { body } = await call('settings.reset', {})
    assert.equal(body.value.settings.retrieval.defaultLimit, 8)
  })

  await test('maintenance.run 返回逐项报告', async () => {
    const { body } = await call('maintenance.run', { tasks: ['cleanup', 'archive'] })
    assert.equal(body.value.tasks.length, 2)
    assert.ok(body.value.totals.total >= 1)
  })

  await test('prompt.preview 给出注入文本', async () => {
    const { body } = await call('prompt.preview', {})
    assert.ok(body.value.text.includes('长期记忆'))
  })

  await test('templates.save / apply / delete 可管理自定义模板', async () => {
    const saved = await call('templates.save', {
      name: 'API 模板',
      header: '## API 自定义模板\n只注入与当前任务相关的条目。',
      topN: 3,
      maxChars: 520,
    })
    const id = saved.body.value.active
    assert.ok(id.startsWith('tpl_'))
    assert.ok(saved.body.value.list.some((entry) => entry.id === id && entry.custom === true))
    const applied = await call('templates.apply', { id: 'default' })
    assert.equal(applied.body.value.active, 'default')
    const deleted = await call('templates.delete', { id })
    assert.equal(deleted.body.value.list.some((entry) => entry.id === id), false)
  })

  await test('pitfalls.record / check 可记录并检索踩坑', async () => {
    const recorded = await call('pitfalls.record', {
      problem: '接口测试：重复安装插件后接口路径冲突',
      cause: '旧前缀路由仍被上一代实例占用',
      solution: '改用带版本号的 API_PATH，并保留旧前缀兼容探测',
      prevention: '升级时同时验证新旧前缀',
    })
    assert.equal(recorded.body.value.item.notebook, 'pitfall')
    const checked = await call('pitfalls.check', { query: '接口路径冲突 重复安装' })
    assert.equal(checked.body.value.found, true)
    assert.ok(checked.body.value.items.length >= 1)
  })

  await test('diff 返回结构化变更与时间范围', async () => {
    const since = new Date(Date.now() - 60000).toISOString()
    const { body } = await call('diff', { since, entity: 'all', limit: 20 })
    assert.ok(body.value.total >= 1)
    assert.ok(Array.isArray(body.value.changes))
    assert.equal(body.value.range.since, since)
  })

  await test('audit.list 记录过前面的写操作', async () => {
    const { body } = await call('audit.list', { limit: 10 })
    assert.ok(body.value.audit.length >= 1)
    assert.ok(body.value.audit.some((entry) => entry.kind === 'change'))
  })

  await test('data.export / data.import 往返', async () => {
    const exported = await call('data.export', {})
    assert.equal(exported.body.value.export.format, 'dsh-memory-plugin')
    const before = engine.stats().total
    const imported = await call('data.import', { data: exported.body.value.export, mode: 'merge' })
    assert.equal(imported.body.value.imported, before)
    assert.equal(engine.stats().total, before * 2)
  })

  await test('未知方法返回 404 且是 JSON 信封', async () => {
    const { status, body } = await call('nope.nope', {})
    assert.equal(status, 404)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'unknown_method')
  })

  await test('非法参数返回 400 与可读消息', async () => {
    const { status, body } = await call('items.create', { content: '短' })
    assert.equal(status, 400)
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'TOO_SHORT')
  })

  await test('跨站 Host 被拒绝', async () => {
    const result = await rawPost({ host: 'evil.example.com', origin: 'http://evil.example.com' }, { method: 'status' })
    assert.equal(result.status, 403)
    assert.ok(result.text.includes('forbidden'))
  })

  await test('同源 GET 兜底也能读状态', async () => {
    const response = await fetch(`${url}/status`)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.version, 1)
  })

  console.log(`\n${passed} 项通过`)
} finally {
  await new Promise((resolve) => server.close(resolve))
}

