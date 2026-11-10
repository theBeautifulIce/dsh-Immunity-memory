/**
 * 记事本渐进式加载的自检脚本。
 *
 * 跑法：node tests/notes-index.test.mjs
 * 覆盖：
 *   - 提示词末尾只挂「每本多少条」的分类目录，不再逐条列标题；
 *   - memory_notes 能按分类 / 关键词列出记事索引（id、标题、一行摘要、是否被引用）；
 *   - memory_notes 记进用量账本（按工具拆分）；
 *   - 拿到 id 后能用 memory_get 取全文；
 *   - 目录里的条数与清单里的条数一致。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { registerTools } from '../packages/memory-plugin/lib/tools.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-notes-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const log = () => {}
const ctx = { get: () => (name) => join(sandbox, name) }
const ref = { engine: null }
const store = createStore(ctx, log, () => ref.engine?.getSettings() ?? normalizeSettings({}))
const engine = await createEngine({ store, initialSettings: normalizeSettings({}), getSettings: () => normalizeSettings({}), log })
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

// 造几本记事：一本日常、一本踩坑、一本资产。
const dailyNote = await engine.createItem({
  type: 'note',
  notebook: 'daily',
  title: '10 月 10 日巡检记录',
  content: '上午巡了三个机柜，散热风扇全部正常，机房温度 26 度。',
}, 'user')
const pitfallNote = await engine.createItem({
  type: 'note',
  notebook: 'pitfall',
  title: '巡检时端口连不上',
  content: '端口被上一台设备的残留会话占着，重启交换机后恢复。',
}, 'user')
const assetNote = await engine.createItem({
  type: 'note',
  notebook: 'asset',
  title: '机柜供电总闸位置',
  content: '供电总闸在 B 通道尽头，红色带盖开关，旁边贴着示意图。',
}, 'user')

// 一条索引记忆：细节挂在 pitfallNote 上。
await engine.createItem({
  layer: 'L4',
  title: '巡检端口连不上的处理办法',
  content: '端口连不上先查残留会话，重启交换机就好。',
  refs: [pitfallNote.id],
  indexMode: true,
  importance: 5,
  ttlDays: 30,
}, 'agent')

await test('提示词末尾只挂分类目录，不逐条列标题', async () => {
  const digest = engine.promptDigest()
  assert.ok(digest.includes('### 记事本目录'), '注入末尾要挂记事本目录')
  assert.ok(digest.includes('memory_notes'), '目录要说明用哪个工具列清单')
  assert.ok(digest.includes('memory_get'), '目录要说明用哪个工具取全文')
  assert.equal(digest.includes('巡检记录'), false, '目录里不该出现具体标题')
  assert.equal(digest.includes(dailyNote.id), false, '目录里不该出现具体 id')
})

await test('目录里的条数与库里的记事条数一致', async () => {
  const stats = engine.injectionStats()
  assert.equal(stats.notesIndexCount, 3, '目录要数出全部三条记事')
  assert.equal(stats.notesIndexGroups, 3, '目录要按本分组')
})

await test('notesIndex 按分类列清单', async () => {
  const index = engine.notesIndex({ notebook: 'pitfall' })
  assert.equal(index.total, 1)
  assert.equal(index.items[0].id, pitfallNote.id)
  assert.equal(index.items[0].notebook, 'pitfall')
  assert.ok(index.items[0].summary.includes('残留会话'), '摘要要能看出这条讲什么')
  assert.ok(index.groups.some((group) => group.id === 'daily' && group.count === 1), '分类计数要覆盖全部本')
})

await test('notesIndex 按关键词过滤', async () => {
  const index = engine.notesIndex({ keyword: '供电' })
  assert.equal(index.total, 1)
  assert.equal(index.items[0].id, assetNote.id)
})

await test('被索引条目引用的记事标 referenced', async () => {
  const index = engine.notesIndex({})
  const referenced = index.items.filter((item) => item.referenced === true)
  assert.equal(referenced.length, 1)
  assert.equal(referenced[0].id, pitfallNote.id)
})

await test('memory_notes 工具能列清单并渲染文字', async () => {
  const registered = new Map()
  const fakeCtx = {
    get: () => (name) => join(sandbox, name),
    tools: {
      register: (definition) => {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }
  const dispose = registerTools(fakeCtx, engine, log)
  try {
    assert.ok(registered.has('memory_notes'), 'memory_notes 要注册上')
    const def = registered.get('memory_notes')
    const value = await def.execute({ notebook: 'daily' }, {})
    assert.equal(value.total, 1)
    assert.equal(value.items[0].id, dailyNote.id)
    const blocks = def.output.render({ notebook: 'daily' }, value)
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.includes('巡检记录'), '渲染里要能看到标题')
    assert.ok(blocks[0].text.includes(dailyNote.id), '渲染里要能看到 id')
    assert.ok(blocks[0].text.includes('memory_get'), '渲染里要告诉模型下一步怎么取全文')
  } finally {
    dispose()
  }
})

await test('memory_notes 记进用量账本', async () => {
  const usage = engine.usageStats({ tool: 'memory_notes' })
  assert.ok(usage.calls >= 1, 'memory_notes 的调用要记进账本')
  assert.ok(usage.totalTokens > 0)
})

await test('拿到 id 后能用 memory_get 取全文', async () => {
  const index = engine.notesIndex({ notebook: 'pitfall' })
  const full = engine.getItem(index.items[0].id)
  assert.ok(full.content.includes('重启交换机'), '全文要能读到完整正文')
})

await engine.deleteItems([dailyNote.id, pitfallNote.id, assetNote.id], 'user')

console.log(`\n通过 ${passed} 项 ✅`)
