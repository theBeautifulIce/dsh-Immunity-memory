/**
 * 索引模式（indexMode）与关联记事（refs）的自检脚本。
 *
 * 跑法：node tests/index-mode.test.mjs
 * 覆盖：
 *   - 索引记忆在注入里只留一行要点 + 指向关联记事本的指针；
 *   - refs 只认「确实存在且是记事」的条目 id；
 *   - 被索引的记事在 memory_notes 清单里被标成 referenced（提示词只挂分类目录）；
 *   - 更新时可以切换索引模式、增删关联；
 *   - JSON 存档与 SQLite 落盘往返后 refs / indexMode 都还在。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createSqliteStore } from '../packages/memory-plugin/lib/sqlite.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-index-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const log = () => {}
const ref = { engine: null }
const store = createStore({ get: () => (name) => join(sandbox, name) }, log, () => ref.engine?.getSettings() ?? normalizeSettings({}))
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

// 细节笔记：索引条目指向它。
const detailNote = await engine.createItem({
  type: 'note',
  notebook: 'pitfall',
  title: '索引细节：灯塔排班',
  content: '灯塔排班按周轮换，交班时要口头复述一遍当天的雾情记录。',
}, 'user')

const longBody = `要点：灯塔排班按周轮换，交班要复述雾情记录。${'细节填充'.repeat(60)}TAIL_IDX_MARK`

await test('索引记忆只留一行要点，正文细节不进注入', async () => {
  const memory = await engine.createItem({
    layer: 'L4',
    title: '灯塔排班规则',
    content: longBody,
    refs: [detailNote.id],
    indexMode: true,
    importance: 5,
    ttlDays: 30,
  }, 'agent')
  assert.deepEqual(memory.refs, [detailNote.id], '关联的记事 id 要落到条目上')
  assert.equal(memory.indexMode, true, '索引模式要落到条目上')

  const digest = engine.promptDigest()
  assert.ok(digest.includes('·索引'), '注入里要标出这是索引条目')
  assert.ok(digest.includes('灯塔排班按周轮换'), '要点本身要留在注入里')
  assert.ok(digest.includes(`「${detailNote.title}」（${detailNote.id}）`), '指针要写清细节在哪条记事里')
  assert.equal(digest.includes('TAIL_IDX_MARK'), false, '索引条目的长正文不应整条进注入')
  assert.ok(digest.includes('memory_get'), '注入要告诉模型按需取全文的方式')
})

await test('提示词里只挂分类目录，标题清单交给 memory_notes', async () => {
  const digest = engine.promptDigest()
  assert.ok(digest.includes('### 记事本目录'), '注入末尾要挂记事本目录')
  assert.ok(digest.includes('memory_notes'), '目录要告诉模型用哪个工具列清单')
  assert.equal(digest.includes('★'), false, '目录里不再逐条列标题，不该出现星标')
  const stats = engine.injectionStats()
  assert.ok(stats.notesIndexGroups >= 1, '目录要给出分类数')
  assert.ok(stats.notesIndexCount >= 1, '目录要给出总条数')
})

await test('被索引的记事在 memory_notes 清单里被标成 referenced', async () => {
  const index = engine.notesIndex({ notebook: 'pitfall' })
  const hit = index.items.find((item) => item.id === detailNote.id)
  assert.ok(hit !== undefined, '清单里要能找到被引用的记事')
  assert.equal(hit.referenced, true, '被索引条目引用的记事要标 referenced')
  assert.ok(index.groups.some((group) => group.id === 'pitfall'), '清单要给出分类计数')
})

await test('普通记忆仍然整条注入，不受影响', async () => {
  const plain = await engine.createItem({
    layer: 'L4',
    title: '港口潮汐表存放位置',
    content: '潮汐表存放在港务局的内网共享盘，文件名带日期。PLAIN_TAIL_MARK',
    importance: 5,
    ttlDays: 30,
  }, 'agent')
  const digest = engine.promptDigest()
  assert.ok(digest.includes('PLAIN_TAIL_MARK'), '非索引记忆的正文要照旧整条注入')
  assert.equal(digest.includes('·索引] 港口潮汐表存放位置'), false, '非索引记忆不该带索引标记')
  await engine.deleteItems([plain.id], 'user')
})

await test('refs 只认确实存在的记事条目', async () => {
  const otherMemory = await engine.createItem({
    layer: 'L5',
    title: '与索引无关的一条记忆',
    content: '这条记忆只是用来验证 refs 不该接受记忆类型的 id。',
    importance: 5,
    ttlDays: 30,
  }, 'agent')
  const sample = await engine.createItem({
    layer: 'L4',
    title: '引用校验样本',
    content: '校验 refs 只认真正存在的记事条目。',
    refs: [detailNote.id, 'mem_并不存在', otherMemory.id, detailNote.id],
    indexMode: true,
    importance: 5,
    ttlDays: 30,
  }, 'agent')
  assert.deepEqual(sample.refs, [detailNote.id], '不存在的 id、记忆 id 和重复 id 都要被去掉')
  await engine.deleteItems([sample.id, otherMemory.id], 'user')
})

await test('更新时可以切换索引模式、增删关联', async () => {
  const memory = await engine.createItem({
    layer: 'L4',
    title: '可切换的索引条目',
    content: '一开始是指针形态的要点。',
    refs: [detailNote.id],
    indexMode: true,
    importance: 5,
    ttlDays: 30,
  }, 'agent')

  const closed = await engine.updateItem(memory.id, { indexMode: false, ttlDays: 30 }, 'user')
  assert.equal(closed.indexMode, false, '索引模式可以被关掉')
  assert.deepEqual(closed.refs, [detailNote.id], '关掉索引模式不该丢掉关联')

  const cleared = await engine.updateItem(memory.id, { refs: [], ttlDays: 30 }, 'user')
  assert.deepEqual(cleared.refs, [], '关联可以被清空')

  const reopened = await engine.updateItem(memory.id, { refs: [detailNote.id], indexMode: true, ttlDays: 30 }, 'user')
  assert.deepEqual(reopened.refs, [detailNote.id])
  assert.equal(reopened.indexMode, true)
  await engine.deleteItems([memory.id], 'user')
})

await test('JSON 存档往返后 refs 与 indexMode 都还在', async () => {
  const memory = await engine.createItem({
    layer: 'L4',
    title: '存档往返样本',
    content: '验证落盘之后关联与索引模式不丢。',
    refs: [detailNote.id],
    indexMode: true,
    importance: 5,
    ttlDays: 30,
  }, 'agent')
  await engine.reload()
  const reloaded = engine.getItem(memory.id)
  assert.deepEqual(reloaded.refs, [detailNote.id])
  assert.equal(reloaded.indexMode, true)
  await engine.deleteItems([memory.id], 'user')
})

await test('SQLite 落盘也保留 refs 与 indexMode', async () => {
  const dbSandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-index-db-'))
  let dbStore = null
  try {
    dbStore = createSqliteStore({ get: () => (...parts) => join(dbSandbox, ...parts) }, log, () => ({ storage: { engine: 'sqlite', backupKeep: 0 } }))
    const dbEngine = await createEngine({ store: dbStore, initialSettings: normalizeSettings({}), getSettings: () => normalizeSettings({}), log })
    const note = await dbEngine.createItem({
      type: 'note',
      notebook: 'pitfall',
      title: '数据库里的细节记事',
      content: 'SQLite 落盘也要留住关联与索引模式。',
    }, 'user')
    const memory = await dbEngine.createItem({
      layer: 'L4',
      title: '数据库索引样本',
      content: '落盘往返后仍然是指针形态。',
      refs: [note.id],
      indexMode: true,
      importance: 5,
      ttlDays: 30,
    }, 'agent')

    const state = dbStore.read()
    const saved = state.items.find((entry) => entry.id === memory.id)
    assert.deepEqual(saved.refs, [note.id], 'SQLite metadata 里要留住 refs')
    assert.equal(saved.indexMode, true, 'SQLite metadata 里要留住 indexMode')

    // 换一个新 store 实例读同一个库：模拟重启后读回。
    const reopened = createSqliteStore({ get: () => (...parts) => join(dbSandbox, ...parts) }, log, () => ({ storage: { engine: 'sqlite', backupKeep: 0 } }))
    const state2 = reopened.read()
    const saved2 = state2.items.find((entry) => entry.id === memory.id)
    assert.deepEqual(saved2.refs, [note.id])
    assert.equal(saved2.indexMode, true)
    reopened.close()
  } finally {
    // 先关库再删目录：Windows 上文件被占着时 rmSync 会报 EBUSY。
    try {
      dbStore?.close()
    } catch {
      /* 已关闭 */
    }
    try {
      rmSync(dbSandbox, { recursive: true, force: true })
    } catch {
      /* 临时目录留着也无所谓 */
    }
  }
})

await engine.deleteItems([detailNote.id], 'user')

console.log(`\n通过 ${passed} 项 ✅`)
