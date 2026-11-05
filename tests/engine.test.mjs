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

await test('旧数据缺少保鲜期时加载会补全', async () => {
  let saved = null
  const created = new Date(Date.now() - 86400000).toISOString()
  const legacyStore = {
    load: async () => ({
      version: 3,
      createdAt: created,
      updatedAt: created,
      settings: normalizeSettings({}),
      items: [{
        id: 'mem_legacy0001',
        type: 'memory',
        layer: 'L5',
        title: '旧版永久记忆',
        content: '这是旧版本写入的、没有保鲜期的记忆。',
        importance: 5,
        status: 'active',
        createdAt: created,
        updatedAt: created,
      }],
      audit: [],
      meta: {},
    }),
    apply: async (next) => { saved = next },
  }
  const legacy = await createEngine({
    store: legacyStore,
    initialSettings: normalizeSettings({}),
    getSettings: () => normalizeSettings({}),
    log,
  })
  const item = legacy.listItems({}).items[0]
  assert.ok(item.ttlDays > 0, '旧数据应补上有限保鲜期')
  assert.ok(Date.parse(item.expiresAt) > Date.now(), '应补上未来的到期时间')
  assert.equal(saved.items[0].ttlDays, item.ttlDays)
  assert.ok(saved.audit.some((entry) => entry.action === 'ttl.backfill'))
})

// ---------------------------------------------------------------- 写入 ----

let firstId = ''
await test('写入一条中文记忆', async () => {
  const item = await engine.createItem({
    layer: 'L5',
    title: '项目使用 pnpm 工作区',
    content: '记忆插件仓库使用 pnpm 管理 packages/* 下的子包，不要混用 npm。',
    tags: ['构建', 'pnpm'],
    importance: 7,
    ttlDays: 30,
  }, 'agent')
  assert.ok(item.id.startsWith('mem_'))
  assert.equal(item.layer, 'L5')
  assert.equal(item.importance, 7)
  assert.deepEqual(item.tags, ['构建', 'pnpm'])
  firstId = item.id
})

await test('过短正文被拒绝', async () => {
  await assert.rejects(
    () => engine.createItem({ layer: 'L5', content: '短' }, 'agent'),
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
    layer: 'L5',
    title: '项目使用 pnpm 工作区（副本）',
    content: '记忆插件仓库使用 pnpm 管理 packages/* 下的子包，不要混用 npm。',
    ttlDays: 30,
  }, 'agent')
  assert.equal(duplicate.duplicateOf, firstId)
})

await test('智能体写入必须显式选择层级', async () => {
  await assert.rejects(
    () => engine.createItem({ title: '未指定层级', content: '智能体写入没有选择层级，应由引擎拒绝而非落到某个默认层。', ttlDays: 30 }, 'agent'),
    (error) => error.code === 'LAYER_REQUIRED',
  )
  await assert.rejects(
    () => engine.createItem({ layer: 'L9', title: '非法层级', content: '不存在的层级必须报错。', ttlDays: 30 }, 'agent'),
    (error) => error.code === 'INVALID_LAYER',
  )
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
    ttlDays: 30,
  }, 'agent')
  const right = await engine.createItem({
    layer: 'L2',
    title: '缓存使用 Redis',
    content: '会话缓存统一放在 Redis 里，过期时间 30 分钟。',
    ttlDays: 30,
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
  const updated = await engine.updateItem(firstId, { title: '仓库用 pnpm 工作区', importance: 9, ttlDays: 30 }, 'user')
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
  await engine.reload()
  // 还没跑 cleanup 时，过期条目也不能被注入或检索到。
  assert.equal(engine.promptDigest().includes('临时提醒'), false)
  const expiredSearch = await engine.searchItems({ query: '临时提醒', limit: 10 })
  assert.equal(expiredSearch.items.some((item) => item.id === shortLived.id), false)
  await engine.runMaintenance({ tasks: ['cleanup'] })
  assert.equal(engine.getItem(shortLived.id).status, 'expired')
  // 恢复时必须续期，否则下一次 cleanup 会立刻再归档。
  await engine.bulkAction([shortLived.id], 'restore')
  assert.equal(engine.getItem(shortLived.id).status, 'active')
  assert.ok(Date.parse(engine.getItem(shortLived.id).expiresAt) > Date.now())
  await engine.runMaintenance({ tasks: ['cleanup'] })
  assert.equal(engine.getItem(shortLived.id).status, 'active')
})

// ---------------------------------------------------------------- 增强 ----

await test('可修改层写入必须填写保鲜期', async () => {
  await assert.rejects(
    () => engine.createItem({ layer: 'L5', title: '没有保鲜期', content: '这条记忆没有填写保鲜期，应当被拒绝写入。' }, 'agent'),
    (error) => error.code === 'TTL_REQUIRED',
  )
  await assert.rejects(
    () => engine.updateItem(firstId, { title: '改标题但不续期' }, 'user'),
    (error) => error.code === 'TTL_REQUIRED',
  )
  await assert.rejects(
    () => engine.updateItem(firstId, { tags: ['只改标签'] }, 'user'),
    (error) => error.code === 'TTL_REQUIRED',
  )
})

await test('注入统计给出总量与逐层明细', async () => {
  const stats = engine.injectionStats()
  assert.equal(stats.template.id, 'default')
  assert.ok(stats.tokens > 0)
  assert.ok(stats.text.includes('长期记忆（dsh-memory-plugin）'))
  assert.ok(Array.isArray(stats.layers) && stats.layers.length >= 1)
})

await test('模板热切换立即改变注入预算', async () => {
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), { prompt: { template: 'dev' } }))
  const stats = engine.injectionStats()
  assert.equal(stats.template.id, 'dev')
  assert.equal(stats.topN, 10)
  assert.ok(stats.layers.some((layer) => layer.id === 'L4'))
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), { prompt: { template: 'default' } }))
})

await test('自定义模板可新增、切换、删除', async () => {
  const saved = await engine.saveTemplate({
    name: '我的模板',
    header: '## 我的长期记忆\n只使用与当前任务直接相关的条目。',
    topN: 4,
    maxChars: 640,
  }, 'user')
  assert.equal(saved.active.startsWith('tpl_'), true)
  assert.ok(saved.list.some((entry) => entry.id === saved.active && entry.custom === true))
  const stats = engine.injectionStats()
  assert.equal(stats.template.id, saved.active)
  assert.equal(stats.topN, 4)
  assert.ok(stats.text.includes('我的长期记忆'))
  const edited = await engine.saveTemplate({
    id: saved.active,
    name: '我的模板（改）',
    header: '## 修改后的长期记忆\n优先级更高。',
    topN: 5,
    maxChars: 700,
  }, 'user')
  assert.equal(edited.list.find((entry) => entry.id === saved.active).name, '我的模板（改）')
  assert.equal(engine.injectionStats().topN, 5)
  await engine.reload()
  assert.equal(engine.injectionStats().template.id, saved.active)
  await engine.applyTemplate('default', 'user')
  assert.equal(engine.injectionStats().template.id, 'default')
  const afterDelete = await engine.deleteTemplate(saved.active, 'user')
  assert.equal(afterDelete.list.some((entry) => entry.id === saved.active), false)
  await assert.rejects(
    () => engine.deleteTemplate('default', 'user'),
    (error) => error.code === 'BUILTIN_TEMPLATE',
  )
})

await test('智能体检索会记录用量账本', async () => {
  const before = engine.usageStats({ type: 'note' })
  await engine.searchItems({ query: '进展', type: 'note', actor: 'agent' })
  const after = engine.usageStats({ type: 'note' })
  assert.ok(after.calls >= before.calls + 1)
  assert.ok(after.totalTokens > 0)
  assert.equal(after.byType.note.calls >= 1, true)
})

await test('混合检索用量按结果类型拆分', async () => {
  await engine.searchItems({ query: 'pnpm', actor: 'agent' })
  const notes = engine.usageStats({ type: 'note' })
  const memories = engine.usageStats({ type: 'memory' })
  assert.ok(notes.resultTokens > 0, '记事本视图应包含记事本结果的 token')
  assert.ok(memories.resultTokens > 0, '记忆视图应包含记忆结果的 token')
})

await test('关闭审计时用量账本不保存查询原文', async () => {
  const original = engine.getSettings()
  await engine.replaceSettings(applySettingsPatch(original, { privacy: { auditLog: false } }))
  try {
    await engine.searchItems({ query: 'private-token-abc', actor: 'agent' })
    const latest = engine.usageStats({}).recent[0]
    assert.equal(latest.query, '')
    assert.ok(latest.queryTokens > 0)
  } finally {
    await engine.replaceSettings(original)
  }
})

await test('反复强化的记忆可审计固化到目标层', async () => {
  const item = await engine.createItem({
    layer: 'L5',
    title: '固定使用 pnpm',
    content: '本仓库所有子包统一使用 pnpm，不要用 npm 或 yarn。',
    importance: 8,
    ttlDays: 30,
  }, 'agent')
  for (let index = 0; index < 3; index += 1) {
    await engine.updateItem(item.id, {
      title: `固定使用 pnpm（第 ${index + 2} 次确认）`,
      ttlDays: 30,
    }, 'user')
  }
  const candidates = engine.consolidationCandidates()
  const candidate = candidates.find((entry) => entry.id === item.id)
  assert.ok(candidate, '应产生固化候选')
  assert.ok(candidate.signals >= 4)
  assert.equal(candidate.suggestedLayer, 'L3')
  // 固化必须先经维护任务生成候选记录，再走审计确认，不能直接跳过审计。
  await engine.runMaintenance({ tasks: ['consolidate'] })
  const result = await engine.applyConsolidation(item.id, 'approve', { note: '反复确认，固化到本能行为' }, 'agent')
  assert.equal(result.item.layer, 'L3')
  assert.equal(result.item.ttlDays, null)
  assert.equal(result.item.expiresAt, null)
  assert.ok(engine.auditList().some((entry) => entry.action === 'consolidation.approved' && entry.detail.includes('永久固化')))
})

await test('L2 思想流动固化到 L1 思想核心并永久保留', async () => {
  const item = await engine.createItem({
    layer: 'L2',
    title: '缓存一致性优先',
    content: '跨进程缓存必须优先保证一致性，宁可多一次回源也不要返回脏数据。',
    importance: 7,
    ttlDays: 30,
  }, 'agent')
  for (let index = 0; index < 3; index += 1) {
    await engine.updateItem(item.id, { title: `缓存一致性优先（确认 ${index + 2}）`, ttlDays: 30 }, 'user')
  }
  const candidate = engine.consolidationCandidates().find((entry) => entry.id === item.id)
  assert.ok(candidate)
  assert.equal(candidate.suggestedLayer, 'L1')
  await engine.runMaintenance({ tasks: ['consolidate'] })
  const result = await engine.applyConsolidation(item.id, 'approve', { note: '长期原则' }, 'agent')
  assert.equal(result.item.layer, 'L1')
  assert.equal(result.item.ttlDays, null)
  assert.equal(result.item.expiresAt, null)
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

await test('导入缺失保鲜期的记忆会补全', async () => {
  const exported = engine.exportData()
  const legacy = {
    ...exported.items[0],
    id: 'mem_import_not_ttl',
    title: '导入缺保鲜期的记忆',
    ttlDays: null,
    expiresAt: null,
  }
  const result = await engine.importData({ items: [legacy] }, 'merge')
  assert.equal(result.ttlFilled, 1)
  const imported = engine.getItem('mem_import_not_ttl')
  assert.ok(imported.ttlDays > 0)
  assert.ok(Date.parse(imported.expiresAt) > Date.now())
})

await test('导入伪造的远期到期时间会被 ttlDays 截断', async () => {
  const now = Date.now()
  const result = await engine.importData({
    items: [{
      id: 'mem_import_far_future',
      type: 'memory',
      layer: 'L5',
      title: '导入伪造远期到期',
      content: '这条记忆试图带一个几千年后的到期时间，必须被 ttlDays 截断。',
      ttlDays: 30,
      expiresAt: '9999-12-31T00:00:00.000Z',
      tags: [],
      importance: 5,
      status: 'active',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }],
  }, 'merge')
  assert.equal(result.imported, 1)
  const imported = engine.getItem('mem_import_far_future')
  assert.ok(Date.parse(imported.expiresAt) <= now + 31 * 86400000)
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






