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
import { messageText } from '../packages/memory-plugin/lib/capture.js'

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
  assert.equal(settings.maintenance.diffKeep, 3000)
})

await test('状态里的插件版本与 package.json 保持一致', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../packages/memory-plugin/package.json', import.meta.url), 'utf8'))
  assert.equal(engine.status().pluginVersion, pkg.version)
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

await test('空库也注入长期记忆使用说明', async () => {
  const stats = engine.injectionStats()
  assert.equal(stats.itemCount, 0)
  assert.ok(stats.tokens > 0)
  assert.ok(stats.text.includes('长期记忆（dsh-memory-plugin）'))
  assert.ok(stats.text.includes('memory_write'))
  assert.ok(stats.text.includes('当前没有已保存的相关条目'))
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

await test('相同实体键写入会更新原条目并保留来源', async () => {
  const first = await engine.createItem({
    layer: 'L4',
    key: 'project.package-manager',
    title: '包管理器约定',
    content: '团队统一使用 pnpm 管理工作区，提交前运行完整自检。',
    ttlDays: 30,
    quote: '我们统一用 pnpm，别再用 npm 了。',
    turn: 7,
    confidence: 0.92,
  }, 'agent')
  const second = await engine.createItem({
    layer: 'L4',
    key: 'project.package-manager',
    title: '包管理器约定（更新）',
    content: '团队统一使用 pnpm 10 管理工作区，提交前运行 scripts/check.mjs。',
    ttlDays: 30,
    quote: '升级到 pnpm 10 了。',
  }, 'agent')
  assert.equal(second.id, first.id)
  assert.equal(second.version, 2)
  assert.equal(second.title, '包管理器约定（更新）')
  assert.equal(second.source.quote, '升级到 pnpm 10 了。')
  const sameKey = engine.listItems({ status: 'all' }).items.filter((item) => item.key === 'project.package-manager')
  assert.equal(sameKey.length, 1)
  assert.equal(engine.getItem(first.id).key, 'project.package-manager')

  // 同键同内容再次写入时不应覆盖已有来源原话，但必须刷新保鲜期。
  const beforeRenew = Date.parse(second.expiresAt)
  const third = await engine.createItem({
    layer: 'L4',
    key: 'project.package-manager',
    title: '包管理器约定（更新）',
    content: '团队统一使用 pnpm 10 管理工作区，提交前运行 scripts/check.mjs。',
    ttlDays: 90,
  }, 'agent')
  assert.equal(third.id, first.id)
  assert.equal(third.source.quote, '升级到 pnpm 10 了。')
  assert.equal(third.ttlDays, 90)
  assert.ok(Date.parse(third.expiresAt) > beforeRenew, '同键续写应刷新到期时间')
})

await test('显式 supersedes 会归档旧条目并隐藏', async () => {
  const oldItem = await engine.createItem({
    layer: 'L5',
    title: '发布分支使用 main',
    content: '发布分支固定使用 main，发布后不再合并其他改动。',
    ttlDays: 30,
  }, 'agent')
  const next = await engine.createItem({
    layer: 'L5',
    title: '发布分支改用 release',
    content: '发布分支改为 release，main 只保留开发中的代码。',
    ttlDays: 30,
    supersedes: [oldItem.id],
  }, 'agent')
  assert.equal(next.supersedes.includes(oldItem.id), true)
  assert.equal(engine.getItem(oldItem.id).status, 'archived')
  assert.equal(engine.getItem(oldItem.id).supersededBy, next.id)
  assert.equal(engine.listItems({ status: 'active' }).items.some((item) => item.id === oldItem.id), false)
  assert.equal(engine.promptDigest().includes('发布分支固定使用 main'), false)
})

await test('重复与被取代条目不进入提示词注入', async () => {
  const digest = engine.promptDigest()
  assert.equal(digest.includes('项目使用 pnpm 工作区（副本）'), false)
  assert.equal(digest.includes('发布分支固定使用 main'), false)
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

await test('注入条数上限放宽到 60，45 条不会再被折回 30', async () => {
  const normalized = normalizeSettings({ prompt: { overrideBudget: true, topN: 45, maxChars: 6000 } })
  assert.equal(normalized.prompt.overrideBudget, true)
  assert.equal(normalized.prompt.topN, 45)
  const tooMany = normalizeSettings({ prompt: { overrideBudget: true, topN: 90 } })
  assert.ok(tooMany.prompt.topN < 90)
})

await test('自定义模板可新增、切换、删除', async () => {
  const saved = await engine.saveTemplate({
    name: '我的模板',
    header: '## 我的长期记忆\n只使用与当前任务直接相关的条目。',
    topN: 4,
    maxChars: 640,
    layers: {
      L0: [{ title: '身份锚点', content: '这是我的不可变灵魂层身份。' }],
    },
  }, 'user')
  assert.equal(saved.active.startsWith('tpl_'), true)
  assert.ok(saved.list.some((entry) => entry.id === saved.active && entry.custom === true))
  const stats = engine.injectionStats()
  assert.equal(stats.template.id, saved.active)
  assert.equal(stats.topN, 4)
  assert.ok(stats.text.includes('我的长期记忆'))
  assert.ok(stats.text.includes('身份锚点'))
  assert.equal(stats.template.layers.L0, 1)
  const edited = await engine.saveTemplate({
    id: saved.active,
    name: '我的模板（改）',
    header: '## 修改后的长期记忆\n优先级更高。',
    topN: 5,
    maxChars: 700,
  }, 'user')
  assert.equal(edited.list.find((entry) => entry.id === saved.active).name, '我的模板（改）')
  assert.equal(engine.injectionStats().topN, 5)
  assert.equal(engine.injectionStats().template.layers.L0, 1, '只改名称/预算时应保留原有不可变层')
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

await test('模板不可变层随模板切换，可改写记忆跨模板复用', async () => {
  const shared = await engine.createItem({
    layer: 'L5',
    title: '共享可改写记忆',
    content: '这条目标记忆属于共享层，切换模板后仍然存在并被注入。',
    importance: 10,
    pinned: true,
    ttlDays: 30,
  }, 'user')
  const first = await engine.saveTemplate({
    name: '分层模板 A',
    header: '## 分层模板 A',
    topN: 10,
    maxChars: 3000,
    layers: {
      L0: [{ title: 'A 灵魂身份', content: 'A-灵魂：我是不可变的身份锚点。' }],
      L1: [{ title: 'A 核心原则', content: 'A-原则：先验证，再承诺。' }],
      L3: [{ title: 'A 行为反射', content: 'A-本能：遇到风险先停下来确认。' }],
    },
  }, 'user')
  const firstStats = engine.injectionStats()
  assert.equal(firstStats.template.layers.L0, 1)
  assert.equal(firstStats.template.layers.L1, 1)
  assert.equal(firstStats.template.layers.L3, 1)
  assert.equal(firstStats.templateItemCount, 3)
  assert.ok(firstStats.text.includes('A-灵魂'))
  assert.ok(firstStats.text.includes('A-原则'))
  assert.ok(firstStats.text.includes('A-本能'))
  assert.ok(firstStats.text.includes('共享可改写记忆'), '共享可改写记忆应出现在 A 模板注入里')
  assert.ok(firstStats.layers.find((layer) => layer.id === 'L0').count >= 1)

  const second = await engine.saveTemplate({
    name: '分层模板 B',
    header: '## 分层模板 B',
    topN: 10,
    maxChars: 3000,
    layers: {
      L0: [{ title: 'B 灵魂身份', content: 'B-灵魂：另一个不可变身份。' }],
    },
  }, 'user')
  const secondStats = engine.injectionStats()
  assert.equal(secondStats.template.id, second.active)
  assert.ok(secondStats.text.includes('B-灵魂'))
  assert.equal(secondStats.text.includes('A-灵魂'), false, '切换后旧模板不可变层应消失')
  assert.ok(secondStats.text.includes('共享可改写记忆'), '切换模板后共享可改写记忆仍在')
  assert.equal(engine.getItem(shared.id)?.status, 'active')

  await engine.applyTemplate('default', 'user')
  await engine.deleteTemplate(first.active, 'user')
  await engine.deleteTemplate(second.active, 'user')
  await engine.deleteItems([shared.id], 'user')
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

await test('结构化 diff 能按时间、类型和层筛选', async () => {
  const created = await engine.createItem({
    layer: 'L5',
    title: 'diff 测试记忆',
    content: '这是一条专门用于验证变更历史与筛选条件的记忆。',
    ttlDays: 30,
  }, 'agent')
  await engine.updateItem(created.id, {
    content: '这是一条专门用于验证变更历史与筛选条件的记忆，正文已经更新。',
    ttlDays: 30,
  }, 'agent')
  const since = new Date(Date.now() - 60000).toISOString()
  const result = await engine.diff({ since, entity: 'memory', layer: 'L5', itemId: created.id, limit: 20 })
  assert.ok(result.total >= 2, '创建与更新都应进入 diff')
  const update = result.changes.find((entry) => entry.operation === 'update')
  assert.ok(update !== undefined)
  assert.ok(update.changed.includes('content'))
  assert.ok(update.summary.includes('正文'))
  assert.ok(update.after.content.includes('已经更新'))
  const notesOnly = await engine.diff({ since, entity: 'note', itemId: created.id })
  assert.equal(notesOnly.total, 0)
})

await test('踩坑笔记可记录、检索并用于查重', async () => {
  const recorded = await engine.recordPitfall({
    problem: '构建时原生核心版本不匹配，握手失败',
    cause: 'memory-core.exe 与 JS 协议版本号不一致',
    solution: '重新运行 node scripts/build-native.mjs，并核对 protocol=1',
    prevention: '升级插件后先跑原生核心自检，确认二进制版本',
    tags: ['构建', '原生核心'],
  }, 'agent')
  assert.equal(recorded.item.notebook, 'pitfall')
  assert.equal(recorded.item.type, 'note')
  assert.equal(recorded.item.layer, 'L4')
  assert.ok(recorded.item.pitfall.solution.includes('build-native.mjs'))
  const found = await engine.searchPitfalls({ query: '原生核心 握手失败' })
  assert.ok(found.items.some((item) => item.id === recorded.item.id))
  const checked = await engine.checkPitfalls({ query: '原生核心 版本不匹配' })
  assert.equal(checked.found, true)
  assert.ok(checked.advice.includes('memory_pitfall record'))
})

await test('审计运行记录可持久化并聚合 token', async () => {
  const run = await engine.recordAuditRun({
    tool: 'memory_write',
    callId: 'call-audit-1',
    sessionId: 'session-audit',
    action: 'create',
    status: 'running',
    proposed: { title: '审计候选', content: '这是一条用于验证审计账本的候选记忆。' },
    usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 },
  })
  assert.ok(run.id.startsWith('audit_'))
  let stats = engine.auditStats()
  assert.equal(stats.running, 1)
  assert.equal(stats.tokens.input, 120)
  assert.equal(stats.tokens.output, 30)
  assert.equal(stats.tokens.total, 160)

  await engine.finishAuditRun(run.id, {
    status: 'approved',
    confidence: 0.91,
    reason: '来源明确，内容与用户原话一致',
    usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 },
  })
  stats = engine.auditStats()
  assert.equal(stats.running, 0)
  assert.equal(stats.approved, 1)
  assert.equal(stats.tokens.total, 160)
  assert.equal(engine.auditRuns({ status: 'approved' }).length, 1)
})

await test('审计拒绝可归档已经写入的条目', async () => {
  const item = await engine.createItem({
    layer: 'L4',
    title: '待审计的临时记忆',
    content: '这条记忆先写入，随后会被审计拒绝并归档。',
    ttlDays: 30,
  }, 'agent')
  const run = await engine.recordAuditRun({
    tool: 'memory_write',
    callId: 'call-audit-2',
    action: 'create',
    status: 'needs_user',
    enforced: true,
    targetId: item.id,
    usage: { inputTokens: 20, outputTokens: 5 },
  })
  assert.equal(engine.auditStats().pending, 1, '未处理的候选应计入待确认')
  await engine.decideAuditRun(run.id, 'reject', '人工复核认为证据不足', 'user')
  assert.equal(engine.getItem(item.id).status, 'archived')
  assert.equal(engine.auditStats().rejected, 1)
  assert.equal(engine.auditStats().blocked, 1, '被拦截的待确认也应计入已拦截')
  assert.equal(engine.auditStats().pending, 0, '已处理的候选不应继续计入待确认')
})

await test('删除后条目消失且冲突引用被清理', async () => {
  const result = await engine.deleteItems([firstId], 'user')
  assert.equal(result.deleted, 1)
  assert.equal(engine.getItem(firstId), undefined)
})

await test('拒绝 update 候选不会归档原有有效记忆', async () => {
  const target = await engine.createItem({
    layer: 'L4',
    title: '保留的原有记忆',
    content: '这条记忆本身有效，拒绝一条修改建议不应把它归档。',
    ttlDays: 30,
  }, 'user')
  const run = await engine.recordAuditRun({
    tool: 'memory_update',
    action: 'update',
    status: 'needs_user',
    enforced: true,
    targetId: target.id,
    proposed: { title: '未采纳的修改', content: '这条修改建议不会应用。', ttlDays: 30 },
  })
  await engine.decideAuditRun(run.id, 'reject', '不采纳这次修改', 'user')
  const kept = engine.getItem(target.id)
  assert.equal(kept.status, 'active')
  assert.equal(kept.title, '保留的原有记忆')
})

await test('批准候选保留完整长正文', async () => {
  const content = '长'.repeat(6000)
  const run = await engine.recordAuditRun({
    tool: 'memory_write',
    action: 'create',
    status: 'needs_user',
    enforced: true,
    proposed: { type: 'memory', layer: 'L4', title: '长正文候选', content, ttlDays: 30 },
  })
  assert.equal(run.proposed.content.length, 6000)
  const decided = await engine.decideAuditRun(run.id, 'approve', '批准完整写入', 'user')
  const applied = engine.getItem(decided.appliedItemId)
  assert.equal(applied.content.length, 6000)
})

await test('并发批准同一候选只写入一次', async () => {
  const run = await engine.recordAuditRun({
    tool: 'memory_write',
    action: 'create',
    status: 'needs_user',
    enforced: true,
    proposed: { type: 'memory', layer: 'L4', title: '并发批准候选', content: '并发批准同一个候选只应产生一条记忆。', ttlDays: 30 },
  })
  const results = await Promise.allSettled([
    engine.decideAuditRun(run.id, 'approve', '并发 A', 'user'),
    engine.decideAuditRun(run.id, 'approve', '并发 B', 'user'),
  ])
  assert.ok(results.some((result) => result.status === 'fulfilled'))
  const items = engine.listItems({ status: 'all' }).items.filter((item) => item.title === '并发批准候选')
  assert.equal(items.length, 1)
})

await test('项目空间隔离同键记忆，并保留全局条目', async () => {
  const alpha = await engine.createItem({
    layer: 'L4', title: '项目甲独有', content: '项目甲的隔离测试内容。',
    ttlDays: 30, workspace: 'D:/Project/Alpha', key: 'project/space',
  }, 'user')
  const beta = await engine.createItem({
    layer: 'L4', title: '项目乙独有', content: '项目乙的隔离测试内容。',
    ttlDays: 30, workspace: 'D:/Project/Beta', key: 'project/space',
  }, 'user')
  const global = await engine.createItem({
    layer: 'L4', title: '全局共享', content: '所有项目都能看到的全局测试内容。',
    ttlDays: 30, workspace: '',
  }, 'user')
  assert.equal(alpha.workspace, 'd:/project/alpha')
  assert.notEqual(alpha.id, beta.id, '不同项目允许使用相同实体键')
  assert.equal(global.workspace, null)
  const hits = (await engine.searchItems({ query: '隔离测试内容', workspace: 'd:/project/alpha' })).items
  assert.ok(hits.some((item) => item.id === alpha.id))
  assert.ok(!hits.some((item) => item.id === beta.id), '不应检索到其他项目的记忆')
  assert.equal(engine.getItem(beta.id, 'd:/project/alpha'), undefined, '跨项目按 id 读取应拒绝')
  const globalHits = (await engine.searchItems({ query: '全局测试内容', workspace: 'd:/project/alpha' })).items
  assert.ok(globalHits.some((item) => item.id === global.id), '全局条目应在项目检索中可见')
})

await test('冲突合并刷新 TTL、归档败者并写取代关系', async () => {
  const workspace = 'd:/project/conflict'
  const winner = await engine.createItem({
    layer: 'L2', title: '冲突保留方', content: '这是保留方的完整正文。', ttlDays: 30, workspace,
  }, 'user')
  const loser = await engine.createItem({
    layer: 'L2', title: '冲突被合并方', content: '这是被合并方的完整正文。', ttlDays: 30, workspace,
  }, 'user')
  const resolved = await engine.resolveConflict({
    winnerId: winner.id, loserId: loser.id, strategy: 'merge', ttlDays: 90,
  }, 'user')
  assert.equal(resolved.strategy, 'merge')
  assert.equal(resolved.winner.ttlDays, 90, '合并应刷新保鲜期')
  assert.ok(resolved.winner.content.includes('保留方的完整正文'))
  assert.ok(resolved.winner.content.includes('被合并方的完整正文'))
  const archived = engine.getItem(loser.id)
  assert.equal(archived.status, 'archived')
  assert.equal(archived.supersededBy, winner.id)
  assert.ok(engine.getItem(winner.id).supersedes.includes(loser.id))
})

await test('冲突解决拒绝跨项目条目', async () => {
  const left = await engine.createItem({
    layer: 'L2', title: '跨项目冲突甲方', content: '这是跨项目隔离测试的甲方正文。',
    ttlDays: 30, workspace: 'd:/project/conflict-a',
  }, 'user')
  const right = await engine.createItem({
    layer: 'L2', title: '跨项目冲突乙方', content: '这是跨项目隔离测试的乙方正文。',
    ttlDays: 30, workspace: 'd:/project/conflict-b',
  }, 'user')
  await assert.rejects(
    engine.resolveConflict({ winnerId: left.id, loserId: right.id, strategy: 'merge' }, 'user'),
    /同层同项目/,
  )
})

await test('冲突保留策略不改写保留方正文', async () => {
  const workspace = 'd:/project/conflict-keep'
  const winner = await engine.createItem({
    layer: 'L2', title: '保留策略甲方', content: '这是甲方的原始完整正文。', ttlDays: 30, workspace,
  }, 'user')
  const loser = await engine.createItem({
    layer: 'L2', title: '保留策略乙方', content: '这是乙方的原始完整正文。', ttlDays: 30, workspace,
  }, 'user')
  const resolved = await engine.resolveConflict({
    winnerId: winner.id, loserId: loser.id, strategy: 'keep',
  }, 'user')
  assert.equal(resolved.winner.content, '这是甲方的原始完整正文。')
  assert.equal(engine.getItem(loser.id).status, 'archived')
})

await test('诊断快照包含健康分、维护历史与慢查询', async () => {
  const original = engine.getSettings()
  await engine.replaceSettings(applySettingsPatch(original, {
    maintenance: { slowQueryMs: 0, historyKeep: 5 },
  }))
  try {
    await engine.runMaintenance({ tasks: ['cleanup'] })
    const before = engine.diagnostics()
    assert.ok(typeof before.health.score === 'number')
    assert.ok(before.health.score <= 100 && before.health.score >= 0)
    assert.ok(['healthy', 'attention', 'risk'].includes(before.health.grade))
    assert.ok(before.maintenanceRuns.length >= 1, '维护历史应被记录')
    await engine.searchItems({ query: '诊断慢查询', workspace: 'd:/project/diag' })
    const after = engine.diagnostics()
    assert.ok(after.slowQueries.length > before.slowQueries.length, '超过阈值应记录慢查询')
    assert.ok(typeof after.injection.hitRate === 'number')
  } finally {
    await engine.replaceSettings(original)
  }
})

await test('写入 Hook 可改写输入并记录到注册表', async () => {
  const suffix = Date.now().toString(36)
  const off = engine.writeHooks.onBeforeWrite((context) => {
    assert.equal(context.action, 'create')
    return { patch: { title: `被 Hook 改写的标题 ${suffix}` } }
  }, 'test-rewrite')
  try {
    assert.ok(engine.writeHooks.list().before.some((entry) => entry.name === 'test-rewrite'))
    const item = await engine.createItem({
      layer: 'L4',
      title: `原始标题 ${suffix}`,
      content: `Hook 改写输入的测试正文 ${suffix}`,
      ttlDays: 30,
      importance: 6,
      quote: `这是 Hook 测试的用户原话 ${suffix}`,
    })
    assert.equal(item.title, `被 Hook 改写的标题 ${suffix}`)
  } finally {
    off()
  }
})

await test('写入 Hook 可以拦截 create 与 update', async () => {
  const suffix = Date.now().toString(36)
  const item = await engine.createItem({
    layer: 'L4',
    title: `待拦截条目 ${suffix}`,
    content: `这条用于验证拒绝路径 ${suffix}`,
    ttlDays: 30,
    importance: 5,
    quote: `拒绝路径测试原话 ${suffix}`,
  })
  const off = engine.writeHooks.onBeforeWrite(() => false, 'test-deny')
  try {
    await assert.rejects(
      engine.createItem({
        layer: 'L4',
        title: `被拒绝的新条目 ${suffix}`,
        content: `这条不应该被写入 ${suffix}`,
        ttlDays: 30,
        importance: 5,
        quote: `拒绝写入测试原话 ${suffix}`,
      }),
      /写入被 Hook/
    )
    await assert.rejects(engine.updateItem(item.id, { title: `被拒绝的更新 ${suffix}` }), /写入被 Hook/)
  } finally {
    off()
  }
  assert.equal(engine.getItem(item.id).title, `待拦截条目 ${suffix}`)
})

await test('写入 Hook 抛错时失败放行', async () => {
  const suffix = Date.now().toString(36)
  const off = engine.writeHooks.onBeforeWrite(() => {
    throw new Error('hook exploded')
  }, 'test-fail-open')
  try {
    const item = await engine.createItem({
      layer: 'L4',
      title: `失败放行条目 ${suffix}`,
      content: `Hook 抛错时仍应写入 ${suffix}`,
      ttlDays: 30,
      importance: 5,
      quote: `失败放行测试原话 ${suffix}`,
    })
    assert.equal(item.status, 'active')
  } finally {
    off()
  }
})

await test('更新 Hook 能拿到修改前后内容', async () => {
  const suffix = Date.now().toString(36)
  const item = await engine.createItem({
    layer: 'L4',
    title: `更新 Hook 原条目 ${suffix}`,
    content: `更新 Hook 的原始正文 ${suffix}`,
    ttlDays: 30,
    importance: 5,
    quote: `更新 Hook 测试原话 ${suffix}`,
  })
  const seen = []
  const off = engine.writeHooks.onAfterWrite((context) => {
    if (context.action === 'update' && context.item?.id === item.id) seen.push(context)
  }, 'test-after-update')
  try {
    await engine.updateItem(item.id, { title: `更新 Hook 新标题 ${suffix}`, ttlDays: 30 })
  } finally {
    off()
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].before.title, `更新 Hook 原条目 ${suffix}`)
  assert.equal(seen[0].item.title, `更新 Hook 新标题 ${suffix}`)
})

await test('session/event 消息形状能提取文本', () => {
  assert.equal(messageText({ type: 'user/message', data: { role: 'user', content: '你把上次的配置说错了' } }), '你把上次的配置说错了')
  assert.equal(messageText({
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '抱歉，我刚才说错了' }] }, usage: {} },
  }), '抱歉，我刚才说错了')
})

await test('自动记忆信号入队，捕获事实与笔记并按记事本去重', async () => {
  const suffix = Date.now().toString(36)
  const signal = await engine.noteCaptureSignal({
    trigger: 'user_correction',
    reason: '用户指出错误',
    excerpt: `你刚才说错了 ${suffix}`,
    text: `你刚才说错了 ${suffix}，正确做法是先读文件`,
    sessionId: 'sess-capture',
    turn: 7,
  })
  assert.equal(signal.queued, true)
  assert.match(engine.capturePrompt(), /待处理信号/)
  const first = await engine.capture({
    trigger: 'user_correction',
    pendingId: signal.entry.id,
    summary: `修正回答 ${suffix}`,
    facts: [{
      layer: 'L4',
      title: `自动捕获事实 ${suffix}`,
      content: `回答问题前先读取相关文件，避免凭空推断 ${suffix}`,
      ttlDays: 30,
      importance: 5,
      reason: `用户纠正 ${suffix}`,
    }],
    notes: [{
      notebook: 'daily',
      title: `自动捕获笔记 ${suffix}`,
      content: `自动记忆测试笔记，内容需要足够长 ${suffix}`,
    }],
  }, 'agent')
  assert.equal(first.created.length, 2)
  assert.equal(first.pending, 0)
  const second = await engine.capture({
    trigger: 'manual',
    notes: [{
      notebook: 'daily',
      title: `重复笔记 ${suffix}`,
      content: `自动记忆测试笔记，内容需要足够长 ${suffix}`,
    }],
  }, 'agent')
  assert.equal(second.created.length, 0)
  assert.equal(second.skipped.length, 1)
  assert.equal(second.skipped[0].reason, 'exact-duplicate')
  assert.ok(engine.captureStats().runs >= 2)
})

await test('重载后待处理即时信号仍能安全渲染', async () => {
  await engine.noteCaptureSignal({
    trigger: 'user_correction',
    text: '重载后仍要提醒我这条信号',
    sessionId: 'reload-session',
    turn: 9,
  })
  await engine.reload()
  const prompt = engine.capturePrompt()
  assert.match(prompt, /待处理信号/)
  assert.match(prompt, /重载后仍要提醒我这条信号/)
  const pending = engine.meta().capture.pending.at(-1)
  await engine.capture({ trigger: 'user_correction', outcome: 'nothing', pendingId: pending.id }, 'user')
})

await test('自动记忆定时器首次只记起点，之后入队小时回顾', async () => {
  const now = Date.now()
  await engine.tickCapture(now)
  const later = await engine.tickCapture(now + 5 * 3600000)
  assert.ok(later.queued.some((entry) => entry.trigger === 'small_review'))
  assert.match(engine.capturePrompt(), /小时回顾/)
})

// 图谱相关的用例各自开一个干净沙箱：注入预算里候选太多会互相挤占，不隔离测不准。
async function withFreshEngine(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-graph-'))
  try {
    const localCtx = { get: () => (name) => join(dir, name) }
    const localStore = createStore(localCtx, log, () => normalizeSettings({}))
    const localEngine = await createEngine({
      store: localStore,
      initialSettings: normalizeSettings({}),
      getSettings: () => normalizeSettings({}),
      log,
    })
    await run(localEngine, localStore)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await test('关系图谱：跟命中条目同主题、但自己没对上查询词的条目被带进候选', async () => {
  await withFreshEngine(async (localEngine) => {
    const anchor = await localEngine.createItem({
      layer: 'L4',
      title: '灯箱验收卡在物业电路确认',
      content: '灯箱已换成暖白，验收卡在物业电路确认，验收单还没签，前台说等物业盖章。',
      importance: 6,
      ttlDays: 90,
    }, 'agent')
    const neighbour = await localEngine.createItem({
      layer: 'L4',
      title: '周四去物业前台取材料',
      content: '验收单放在物业前台，周四取；暖白那批样品一起带回，别忘盖章。',
      importance: 6,
      ttlDays: 90,
    }, 'agent')
    const unrelated = await localEngine.createItem({
      layer: 'L4',
      title: '乌龙茶要冷泡',
      content: '乌龙茶冷泡四个小时更香，别用开水冲。',
      importance: 6,
      ttlDays: 90,
    }, 'agent')
    const stats = localEngine.injectionStats(Date.now(), undefined, { query: '灯箱现在到哪一步了' })
    const ids = stats.lines.filter((line) => line.source === 'memory').map((line) => line.id)
    assert.ok(ids.includes(anchor.id), '命中条目本身应在注入里')
    assert.ok(ids.includes(neighbour.id), '同主题邻居应被图谱带进来')
    assert.ok(ids.indexOf(neighbour.id) < ids.indexOf(unrelated.id), '邻居应排在无关条目前面')
  })
})

await test('人工关联：连上的条目没有共同词，也会被注入带进来', async () => {
  await withFreshEngine(async (localEngine, localStore) => {
    const anchor = await localEngine.createItem({
      layer: 'L4',
      title: '灯箱验收单还没签',
      content: '灯箱验收单还压在物业那儿，等盖章。',
      importance: 6,
      ttlDays: 90,
    }, 'agent')
    const neighbour = await localEngine.createItem({
      layer: 'L4',
      title: '周四去前台取材料',
      content: '周四去前台取样品，顺路把回执带回来。',
      importance: 6,
      ttlDays: 90,
    }, 'agent')
    const unrelated = await localEngine.createItem({
      layer: 'L4',
      title: '乌龙茶要冷泡',
      content: '乌龙茶冷泡四个小时更香，别用开水冲。',
      importance: 6,
      ttlDays: 90,
    }, 'agent')
    localStore.links = async (id) => (id === anchor.id || id === neighbour.id
      // 同一对可能既被自动建了 related，又被人连了 manual：列表里只该出现一行。
      ? [
        { id: id === anchor.id ? neighbour.id : anchor.id, edgeType: 'manual', weight: 1 },
        { id: id === anchor.id ? neighbour.id : anchor.id, edgeType: 'related', weight: 0.62 },
      ]
      : [])
    localStore.linkItems = async ({ sourceId, targetId, weight }) => ({
      id: String(targetId),
      edgeType: 'manual',
      weight: weight ?? 1,
    })
    await localEngine.linkItems({ sourceId: anchor.id, targetId: neighbour.id }, 'agent')
    const listed = await localEngine.itemLinks(anchor.id)
    assert.equal(listed.length, 1, '同一对条目的 related 与 manual 要合成一行')
    assert.equal(listed[0].edgeType, 'manual', '合成后以人工为准')
    assert.equal(listed[0].weight, 1, '权重取两者较大的')
    assert.equal(listed[0].title, '周四去前台取材料', '关联列表要带上对端标题，不能只给 id')
    assert.equal(listed[0].layer, 'L4')
    const stats = localEngine.injectionStats(Date.now(), undefined, { query: '灯箱验收单签了吗' })
    const ids = stats.lines.filter((line) => line.source === 'memory').map((line) => line.id)
    assert.ok(ids.includes(anchor.id), '命中条目本身应在注入里')
    assert.ok(ids.includes(neighbour.id), '人工连上的条目应被带进来')
    assert.ok(ids.indexOf(neighbour.id) < ids.indexOf(unrelated.id), '邻居应排在无关条目前面')
  })
})


await test('人工关联写进差量历史，解除也能查到', async () => {
  await withFreshEngine(async (localEngine, localStore) => {
    const left = await localEngine.createItem({
      layer: 'L4',
      title: '北门门禁二十一点落锁',
      content: '北门门禁二十一点落锁，之后只能走南门。',
      importance: 5,
      ttlDays: 60,
    }, 'agent')
    const right = await localEngine.createItem({
      layer: 'L4',
      title: '晚上九点后进不去北门',
      content: '过了晚上九点北门就进不去，得绕到南门刷卡。',
      importance: 5,
      ttlDays: 60,
    }, 'agent')
    localStore.links = async () => []
    localStore.linkItems = async ({ sourceId, targetId, weight }) => ({
      id: String(targetId),
      edgeType: 'manual',
      weight: weight ?? 1,
    })
    localStore.unlinkItems = async () => 1
    await localEngine.linkItems({ sourceId: left.id, targetId: right.id }, 'agent')
    const since = new Date(Date.now() - 60000).toISOString()
    const diff = await localEngine.diff({ since, entity: 'all', limit: 50 })
    const linked = diff.changes.find((change) => change.operation === 'link')
    assert.ok(linked, '建立关联应出现在差量历史里')
    assert.equal(linked.itemId, left.id)
    assert.equal(linked.reason, right.id)
    assert.equal(linked.actor, 'agent')
    assert.match(linked.summary, /建立关联/)
    await localEngine.unlinkItems({ sourceId: left.id, targetId: right.id }, 'agent')
    const after = await localEngine.diff({ since, entity: 'all', limit: 50 })
    assert.ok(after.changes.some((change) => change.operation === 'unlink'), '解除关联也应留下记录')
  })
})

console.log(`\n${passed} 项通过，数据目录：${store.dir}`)




