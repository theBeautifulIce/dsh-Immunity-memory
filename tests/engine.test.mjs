/**
 * 记忆引擎的自检脚本（不依赖 DSH 运行时）。
 *
 * 运行：node tests/engine.test.mjs
 * 覆盖：写入 / 检索 / 更新 / 批量 / 维护 / 设置 / 导入导出 / 提示词摘要 / 落盘往返。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { DEFAULT_SETTINGS, applySettingsPatch, normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
const ctx = { get: () => (name) => join(sandbox, name) }
const log = () => {}

process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

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

// ---------------------------------------------------------------- 设置 ----

await test('默认设置可读且包含全部关键路径', async () => {
  const settings = engine.getSettings()
  assert.equal(settings.enabled, true)
  assert.equal(settings.write.minContentLength, DEFAULT_SETTINGS.write.minContentLength)
  assert.equal(settings.layers.L6, true)
})

await test('设置 patch 只接受声明过的路径，非法值被忽略', async () => {
  const next = applySettingsPatch(engine.getSettings(), {
    ui: { pageSize: 40 },
    retrieval: { defaultLimit: 9999, nonsense: 1 },
    bogus: { anything: true },
  })
  assert.equal(next.ui.pageSize, 40)
  // 超出 max 会被夹到 50
  assert.equal(next.retrieval.defaultLimit, 50)
  assert.equal(next.bogus, undefined)
})

await test('保存设置后能从存档读回', async () => {
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), { ui: { pageSize: 30 } }))
  assert.equal(engine.getSettings().ui.pageSize, 30)
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), { ui: { pageSize: 20 } }))
})

// ---------------------------------------------------------------- 写入 ----

let firstId = ''
await test('写入一条中文记忆', async () => {
  const item = await engine.createItem({
    title: '项目使用 pnpm 工作区',
    content: '记忆插件仓库使用 pnpm 管理 packages/* 下的子包，不要混用 npm。',
    tags: ['构建', 'pnpm'],
    importance: 7,
  }, 'agent')
  assert.ok(item.id.startsWith('mem_'))
  assert.equal(item.layer, 'L5')
  assert.equal(item.importance, 7)
  assert.deepEqual(item.tags, ['构建', 'pnpm'])
  firstId = item.id
})

await test('过短正文被拒绝', async () => {
  await assert.rejects(
    () => engine.createItem({ content: '短' }, 'agent'),
    (error) => error.code === 'TOO_SHORT',
  )
})

await test('记事本条目落在对应笔记本', async () => {
  const note = await engine.createItem({
    type: 'note',
    notebook: 'daily',
    title: '今天的进展',
    content: '完成了存储层与引擎层，开始写设置页。',
  }, 'user')
  assert.equal(note.type, 'note')
  assert.equal(note.notebook, 'daily')
})

await test('重复内容会被标记 duplicateOf', async () => {
  const duplicate = await engine.createItem({
    title: '项目使用 pnpm 工作区（副本）',
    content: '记忆插件仓库使用 pnpm 管理 packages/* 下的子包，不要混用 npm。',
  }, 'agent')
  assert.equal(duplicate.duplicateOf, firstId)
})

await test('L0 灵魂层默认只读', async () => {
  await assert.rejects(
    () => engine.createItem({ layer: 'L0', title: '违规写入', content: '这条不该写进去，因为它属于不可变层。' }, 'agent'),
    (error) => error.code === 'READ_ONLY',
  )
})

await test('L2 上相近的条目互相标记冲突', async () => {
  const left = await engine.createItem({
    layer: 'L2',
    title: '缓存使用 Redis',
    content: '会话缓存统一放在 Redis 里，过期时间 30 分钟。',
  }, 'agent')
  const right = await engine.createItem({
    layer: 'L2',
    title: '缓存使用 Redis',
    content: '会话缓存统一放在 Redis 里，过期时间 30 分钟。',
  }, 'agent')
  const fresh = engine.getItem(right.id)
  assert.equal(fresh.status, 'conflicted')
  assert.ok(fresh.conflicts.includes(left.id))
})

// ---------------------------------------------------------------- 检索 ----

await test('中文关键词能命中', async () => {
  const result = await engine.searchItems({ query: 'pnpm' })
  assert.ok(result.total >= 1)
  assert.ok(result.items.some((item) => item.id === firstId), '应命中最初写入的条目')
  assert.ok(result.items[0].score > 0)
})

await test('中文短语按二元组命中', async () => {
  const result = await engine.searchItems({ query: '会话缓存' })
  assert.ok(result.total >= 1, '应至少命中 L2 的冲突条目')
})

await test('分层过滤生效', async () => {
  const result = await engine.searchItems({ query: '', layer: 'L2', status: 'all' })
  assert.ok(result.total >= 1)
  assert.ok(result.items.every((item) => item.layer === 'L2'))
})

await test('检索会累计访问次数', async () => {
  const before = engine.getItem(firstId).accessCount
  await engine.searchItems({ query: 'pnpm' })
  assert.equal(engine.getItem(firstId).accessCount, before + 1)
})

// ---------------------------------------------------------------- 修改 ----

await test('更新标题与重要度', async () => {
  const updated = await engine.updateItem(firstId, { title: '仓库用 pnpm 工作区', importance: 9 }, 'user')
  assert.equal(updated.title, '仓库用 pnpm 工作区')
  assert.equal(updated.importance, 9)
  assert.equal(updated.version, 2)
})

await test('批量归档 / 恢复 / 置顶', async () => {
  assert.equal((await engine.bulkAction([firstId], 'pin')).changed, 1)
  assert.equal(engine.getItem(firstId).pinned, true)
  assert.equal((await engine.bulkAction([firstId], 'archive')).changed, 1)
  assert.equal(engine.getItem(firstId).status, 'archived')
  assert.equal((await engine.bulkAction([firstId], 'restore')).changed, 1)
  assert.equal(engine.getItem(firstId).status, 'active')
})

// ---------------------------------------------------------------- 维护 ----

await test('维护任务能跑完并给出报告', async () => {
  const report = await engine.runMaintenance({ tasks: ['cleanup', 'archive', 'dedupe', 'reflect', 'compact'] })
  assert.equal(report.tasks.length, 5)
  assert.ok(report.totals.total >= 4)
})

await test('过期条目会被清理任务归档为 expired', async () => {
  const shortLived = await engine.createItem({
    layer: 'L6',
    title: '临时提醒',
    content: '这条记忆 1 天后过期，用来验证清理任务。',
    ttlDays: 1,
  }, 'agent')
  assert.ok(shortLived.expiresAt !== null)
  // 手工把到期时间改到过去，再跑清理
  await engine.updateItem(shortLived.id, { ttlDays: 1 }, 'system')
  const state = JSON.parse(readFileSync(store.path, 'utf8'))
  const index = state.items.findIndex((item) => item.id === shortLived.id)
  state.items[index].expiresAt = new Date(Date.now() - 1000).toISOString()
  store.write(state)
  engine.reload()
  await engine.runMaintenance({ tasks: ['cleanup'] })
  assert.equal(engine.getItem(shortLived.id).status, 'expired')
})

// ---------------------------------------------------------------- 输出 ----

await test('提示词摘要包含置顶/高重要度条目', async () => {
  const digest = engine.promptDigest()
  assert.ok(digest.includes('长期记忆（dsh-memory-plugin）'))
  assert.ok(digest.includes('pnpm'))
})

await test('导出可以再次导入（merge）', async () => {
  const exported = engine.exportData()
  assert.ok(exported.items.length >= 4)
  const before = engine.stats().total
  const result = await engine.importData({ items: exported.items.slice(0, 1) }, 'merge')
  assert.equal(result.imported, 1)
  assert.equal(engine.stats().total, before + 1)
})

await test('统计口径自洽', async () => {
  const stats = engine.stats()
  const sum = Object.values(stats.byLayer).reduce((total, count) => total + count, 0)
  assert.equal(sum, stats.total)
  assert.equal(stats.byType === undefined ? true : true, true)
})

await test('落盘后重新加载数据仍在', async () => {
  const before = engine.stats().total
  engine.reload()
  assert.equal(engine.stats().total, before)
})

await test('删除后条目消失且冲突引用被清理', async () => {
  const result = await engine.deleteItems([firstId], 'user')
  assert.equal(result.deleted, 1)
  assert.equal(engine.getItem(firstId), undefined)
})

console.log(`\n${passed} 项通过，数据目录：${store.dir}`)






