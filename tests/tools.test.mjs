/**
 * 工具注册测试：用 DSH 公布的 `ToolDefinition` / `JsonSchemaNode` 契约校验每一个工具，
 * 并真正执行一遍工具，检查返回值与渲染出的文本。
 *
 * 运行：node tests/tools.test.mjs
 *
 * 为什么要有这个测试：工具 schema 里用错一个字段（例如把 `type` 写成数组、
 * 把 `additionalProperties` 写成对象）会让 `ctx.tools.register` 抛错，
 * 而插件对注册错误是"记录并跳过"的——模型端只会看到工具消失，很难排查。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { registerTools } from '../packages/memory-plugin/lib/tools.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-tools-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const log = () => {}
const ctx = { get: () => (name) => join(sandbox, name) }
const ref = { engine: null }
const store = createStore(ctx, log, () => ref.engine?.getSettings() ?? normalizeSettings({}))
const engine = await createEngine({ store, initialSettings: normalizeSettings({}), getSettings: () => normalizeSettings({}), log })
ref.engine = engine

// ------------------------------------------------------- JsonSchemaNode 校验 ----

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
const SCALARS = new Set(['string', 'number', 'boolean'])

function validateNode(node, path) {
  assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${path} 必须是对象`)
  for (const key of Object.keys(node)) {
    assert.ok(KEYS.has(key), `${path} 含有 JsonSchemaNode 之外的字段 "${key}"`)
  }
  if (node.type !== undefined) {
    assert.equal(typeof node.type, 'string', `${path}.type 必须是单个字符串`)
    assert.ok(TYPES.has(node.type), `${path}.type 非法：${node.type}`)
  }
  if (node.type === 'array') assert.ok(node.items !== undefined, `${path} 是数组但缺少 items`)
  if (node.items !== undefined) validateNode(node.items, `${path}.items`)
  if (node.properties !== undefined) {
    assert.equal(typeof node.properties, 'object', `${path}.properties 必须是对象`)
    for (const [key, child] of Object.entries(node.properties)) validateNode(child, `${path}.properties.${key}`)
  }
  if (node.required !== undefined) {
    assert.ok(Array.isArray(node.required), `${path}.required 必须是数组`)
    for (const key of node.required) {
      assert.equal(typeof key, 'string', `${path}.required 含非字符串`)
      if (node.properties !== undefined) assert.ok(key in node.properties, `${path}.required 引用了不存在的属性 ${key}`)
    }
  }
  if (node.additionalProperties !== undefined) {
    assert.equal(typeof node.additionalProperties, 'boolean', `${path}.additionalProperties 必须是布尔值`)
  }
  if (node.oneOf !== undefined) {
    assert.ok(Array.isArray(node.oneOf) && node.oneOf.length > 0, `${path}.oneOf 必须是非空数组`)
    node.oneOf.forEach((child, index) => validateNode(child, `${path}.oneOf[${index}]`))
  }
  if (node.enum !== undefined) {
    assert.ok(Array.isArray(node.enum), `${path}.enum 必须是数组`)
    for (const value of node.enum) {
      assert.ok(value === null || SCALARS.has(typeof value), `${path}.enum 含非标量值`)
    }
  }
}

/** 按 output.schema 校验实际返回值（支持 type/properties/items/oneOf/enum/additionalProperties）。 */
function assertMatchesSchema(value, node, path) {
  if (node === undefined) return
  if (node.oneOf !== undefined) {
    const matched = node.oneOf.some((branch) => {
      try {
        assertMatchesSchema(value, branch, path)
        return true
      } catch {
        return false
      }
    })
    assert.ok(matched, `${path} 不匹配任何 oneOf 分支（实际 ${JSON.stringify(value)}）`)
    return
  }
  if (node.enum !== undefined) assert.ok(node.enum.includes(value), `${path} 不在枚举内：${value}`)
  if (node.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} 应为对象`)
    for (const key of node.required ?? []) assert.ok(key in value, `${path} 缺少必填字段 ${key}`)
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (value[key] === undefined) continue
      assertMatchesSchema(value[key], child, `${path}.${key}`)
    }
    return
  }
  if (node.type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应为数组`)
    value.forEach((entry, index) => assertMatchesSchema(entry, node.items, `${path}[${index}]`))
    return
  }
  if (node.type === 'string') assert.equal(typeof value, 'string', `${path} 应为字符串，实际 ${typeof value}`)
  else if (node.type === 'number' || node.type === 'integer') assert.equal(typeof value, 'number', `${path} 应为数字`)
  else if (node.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} 应为布尔`)
  else if (node.type === 'null') assert.equal(value, null, `${path} 应为 null`)
}
const registered = new Map()

/** 递归确认返回值只含无损 JSON 值（宿主会拒收 undefined / NaN / 函数）。 */
function assertLossless(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} 含非有限数字`)
    return
  }
  assert.notEqual(value, undefined, `${path} 含 undefined`)
  assert.equal(typeof value, 'object', `${path} 含不可序列化的 ${typeof value}`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertLossless(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value)) assertLossless(entry, `${path}.${key}`)
}
const fakeCtx = {
  tools: {
    register(definition) {
      assert.equal(typeof definition.name, 'string')
      assert.ok(definition.name.length > 0)
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${definition.name} 的说明太短`)
      assert.equal(typeof definition.parameters, 'object')
      assert.equal(definition.parameters.type, 'object', `${definition.name}.parameters 必须是对象 schema`)
      assert.ok(definition.output !== undefined, `${definition.name} 缺少 output`)
      validateNode(definition.output.schema, `${definition.name}.output.schema`)
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(typeof definition.execute, 'function')
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
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

const dispose = registerTools(fakeCtx, engine, log)

await test('注册了全部 12 个工具', () => {
  assert.deepEqual([...registered.keys()].sort(), [
    'memory_capture', 'memory_consolidate', 'memory_diff', 'memory_forget', 'memory_get', 'memory_link',
    'memory_pitfall', 'memory_search', 'memory_stats', 'memory_update', 'memory_usage', 'memory_write',
  ])
})

await test('memory_write 写入并渲染确认文本', async () => {
  const def = registered.get('memory_write')
  const value = await def.execute(
    { content: '工具测试：记忆插件使用 JSON 文件存储。', layer: 'L4', tags: ['测试'], ttlDays: 30 },
    { turn: 42, agent: { session: { id: 'sess-tools-1' } } },
  )
  assert.equal(value.saved, true)
  assert.ok(value.item.id.startsWith('mem_'))
  const stored = engine.getItem(value.item.id)
  assert.equal(stored.source.sessionId, 'sess-tools-1')
  assert.equal(stored.source.turn, 42)
  const blocks = def.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('已保存'))
})

await test('memory_write 用实体键幂等更新并保留来源原话', async () => {
  const def = registered.get('memory_write')
  const first = await def.execute({
    content: '工具测试：项目统一使用 pnpm 管理依赖。',
    layer: 'L4',
    key: 'tool-test-package-manager',
    quote: '以后都用 pnpm。',
    ttlDays: 30,
  }, {})
  const second = await def.execute({
    content: '工具测试：项目统一使用 pnpm 10 管理依赖。',
    layer: 'L4',
    key: 'tool-test-package-manager',
    quote: '以后都用 pnpm 10。',
    ttlDays: 30,
  }, {})
  assert.equal(second.item.id, first.item.id)
  assert.equal(second.item.content.includes('pnpm 10'), true)
  assert.equal(engine.getItem(first.item.id).source.quote, '以后都用 pnpm 10。')
})

await test('memory_search 命中刚写入的记忆', async () => {
  const def = registered.get('memory_search')
  const value = await def.execute({ query: 'JSON 文件存储' }, {})
  assert.ok(value.total >= 1)
  const blocks = def.output.render({ query: 'JSON 文件存储' }, value)
  assert.ok(blocks[0].text.includes('命中'))
})

await test('memory_get 返回完整正文', async () => {
  const def = registered.get('memory_get')
  const found = await registered.get('memory_search').execute({ query: 'JSON 文件存储' }, {})
  const value = await def.execute({ id: found.items[0].id }, {})
  assert.ok(value.item.content.length > 0)
  assert.ok(def.output.render({ id: value.item.id }, value)[0].text.includes(value.item.title))
})

await test('memory_update 改标题', async () => {
  const def = registered.get('memory_update')
  const found = await registered.get('memory_search').execute({ query: 'JSON 文件存储' }, {})
  const value = await def.execute({ id: found.items[0].id, importance: 9, ttlDays: 30 }, {})
  assert.equal(value.item.importance, 9)
  assert.ok(def.output.render({ id: value.item.id }, value)[0].text.includes('已更新'))
})

await test('memory_pitfall 记录后可检索并渲染解决办法', async () => {
  const def = registered.get('memory_pitfall')
  const recorded = await def.execute({
    action: 'record',
    problem: '工具测试：SQLite 数据库被占用无法删除',
    cause: '仍有连接没有关闭',
    solution: '先关闭存储与引擎，再重试删除临时目录',
    prevention: '测试结束统一释放 store',
  }, {})
  assert.equal(recorded.item.notebook, 'pitfall')
  const checked = await def.execute({ action: 'check', query: '数据库被占用 无法删除' }, {})
  assert.equal(checked.found, true)
  const rendered = def.output.render({ action: 'check' }, checked)[0].text
  assert.ok(rendered.includes('先关闭存储'))
})

await test('memory_diff 记录写入并渲染时间线', async () => {
  const def = registered.get('memory_diff')
  const value = await def.execute({ since: new Date(Date.now() - 60000).toISOString(), limit: 50 }, {})
  assert.ok(value.total >= 1)
  assert.ok(Array.isArray(value.changes))
  const rendered = def.output.render({}, value)[0].text
  assert.ok(rendered.includes('变更'))
})

await test('memory_stats 统计与渲染一致', async () => {
  const def = registered.get('memory_stats')
  const value = await def.execute({}, {})
  assert.ok(value.total >= 1)
  assert.equal(typeof value.byLayer, 'object')
  assert.ok(def.output.render({}, value)[0].text.includes('共'))
})

await test('memory_usage 返回智能体查询用量', async () => {
  const def = registered.get('memory_usage')
  const value = await def.execute({ type: 'memory' }, {})
  assert.ok(value.calls >= 1)
  assert.ok(value.totalTokens > 0)
  assert.ok(def.output.render({}, value)[0].text.includes('用量'))
})

await test('memory_consolidate 列出候选并拒绝空操作', async () => {
  const def = registered.get('memory_consolidate')
  const value = await def.execute({ action: 'list' }, {})
  assert.ok(Array.isArray(value.candidates))
  await assert.rejects(
    () => def.execute({ action: 'approve' }, {}),
    (error) => /id/.test(error.message),
  )
})

await test('memory_capture 写入事实与笔记并返回计数', async () => {
  const def = registered.get('memory_capture')
  const suffix = Date.now().toString(36)
  const value = await def.execute({
    trigger: 'user_remember',
    summary: `工具捕获 ${suffix}`,
    facts: [{
      layer: 'L4',
      title: `工具捕获事实 ${suffix}`,
      content: `这是通过 memory_capture 写入的事实 ${suffix}`,
      ttlDays: 30,
      importance: 5,
      reason: `用户要求记住 ${suffix}`,
    }],
    notes: [{
      notebook: 'daily',
      title: `工具捕获笔记 ${suffix}`,
      content: `这是通过 memory_capture 写入的笔记 ${suffix}`,
    }],
  }, { turn: 9, cwd: 'D:/tools-project', agent: { session: { id: 'sess-tools-capture' } } })
  assert.equal(value.created, 2)
  assert.equal(value.errors, 0)
  assert.equal(value.pending, 0)
  const blocks = def.output.render({}, value)
  assert.match(blocks[0].text, /新建 2 条/)
})

await test('memory_link 在 JSON 存储上能列空关联，写入被明确拒绝', async () => {
  const def = registered.get('memory_link')
  const found = await registered.get('memory_search').execute({ query: 'JSON 文件存储' }, {})
  const listed = await def.execute({ action: 'list', id: found.items[0].id }, {})
  assert.equal(listed.count, 0)
  assert.ok(def.output.render({ action: 'list' }, listed)[0].text.includes('还没有关联'))
  await assert.rejects(
    () => def.execute({ action: 'link', id: found.items[0].id, targetId: 'mem_missing' }, {}),
    (error) => /不支持人工关联/.test(error.message),
  )
})

await test('memory_forget 删除后检索不到', async () => {
  const def = registered.get('memory_forget')
  const found = await registered.get('memory_search').execute({ query: 'JSON 文件存储' }, {})
  const value = await def.execute({ ids: found.items.map((item) => item.id) }, {})
  assert.ok(value.deleted >= 1)
  const after = await registered.get('memory_search').execute({ query: 'JSON 文件存储' }, {})
  assert.equal(after.total, 0)
})

await test('工具返回值是无损 JSON', async () => {
  const samples = [
    ['memory_write', { layer: 'L5', content: '无损 JSON 校验：这条记忆用于验证工具返回值序列化。', ttlDays: 30 }],
    ['memory_search', { query: '无损 JSON' }],
    ['memory_stats', {}],
  ]
  for (const [name, args] of samples) {
    const value = await registered.get(name).execute(args, {})
    assertLossless(value, name)
    assertMatchesSchema(value, registered.get(name).output.schema, name)
  }
})
await test('释放函数注销全部工具', () => {
  dispose()
  assert.equal(registered.size, 0)
})

console.log(`\n${passed} 项通过`)





