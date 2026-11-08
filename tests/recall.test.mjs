/**
 * 召回重排自检：提示词注入要跟着「当轮在聊什么」走，而不是永远按重要度排。
 *
 * 复现场景：库里躺着一条「pwsh 挂了要请用户发 /permission f」的记忆，
 * 但它的重要度不高；如果只按重要度排，遇到同一条报错时它永远排在后面。
 * 有了当轮上下文（工具报错文本）之后，它应该被顶到最前面并带「命中」标记。
 *
 * 运行：node tests/recall.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-recall-'))
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

const memoryLines = (stats) => stats.lines.filter((line) => line.source === 'memory')

await engine.createItem({
  layer: 'L4',
  title: 'pwsh 挂了要请用户发 /permission f，不会自愈',
  content: 'OneBot 持久 pwsh 报 PTY shell exited during startup 时不会自己恢复，必须请用户在 QQ 窗口发 /permission f；不要反复重试同一条命令。',
  ttlDays: 30,
  importance: 4,
  tags: ['pwsh', 'pty'],
}, 'user')

await engine.createItem({
  layer: 'L5',
  title: 'B站只许看，不许留言评论',
  content: '浏览 B 站只读取，不发表评论、不发弹幕、不点赞。',
  ttlDays: 30,
  importance: 9,
  tags: ['bilibili'],
}, 'user')

await engine.createItem({
  layer: 'L5',
  title: '发消息时链接和命令必须单独成条',
  content: '给用户发 QQ 消息时，链接与命令各自单独一条，别埋在大段文字里。',
  ttlDays: 30,
  importance: 8,
  tags: ['qq'],
}, 'user')

await test('没有当轮上下文时按重要度排序', async () => {
  const stats = engine.injectionStats()
  assert.equal(stats.query.used, false)
  const lines = memoryLines(stats)
  assert.equal(lines.length, 3)
  assert.match(lines[0].title, /B站只许看/)
  assert.equal(stats.text.includes('·命中'), false, '没有上下文时不该出现命中标记')
})

await test('工具报错进入上下文后，相关记忆被顶到最前并标命中', async () => {
  const noted = engine.noteTurnContext({
    sessionId: 'session-a',
    kind: 'tool',
    text: 'Error: PTY shell exited during startup',
  })
  assert.equal(noted, true)
  const stats = engine.injectionStats()
  assert.equal(stats.query.used, true)
  assert.ok(stats.query.tokens > 0)
  const lines = memoryLines(stats)
  assert.match(lines[0].title, /pwsh 挂了要请用户发/, '相关条应排第一')
  assert.ok((lines[0].relevance ?? 0) >= 0.12, '相关条应带命中相关度')
  assert.match(stats.text, /·命中\] pwsh 挂了要请用户发/)
  assert.ok((lines[0].matched ?? 0) >= 2, '命中要至少对上两个查询词，避免单个通用词误伤')
  // 不相关的条目照旧注入，但不能被标成命中。
  const others = lines.slice(1)
  for (const line of others) assert.ok((line.relevance ?? 0) < 0.12)
})

await test('同一句上下文重复记录只留一份', async () => {
  const again = engine.noteTurnContext({ sessionId: 'session-a', kind: 'tool', text: 'Error: PTY shell exited during startup' })
  assert.equal(again, false)
  assert.equal(engine.turnContext().entries, 1)
})

await test('换会话后上下文重置，排序退回重要度', async () => {
  engine.noteTurnContext({ sessionId: 'session-b', kind: 'user', text: '今天想看点别的' })
  const stats = engine.injectionStats()
  const lines = memoryLines(stats)
  assert.match(lines[0].title, /B站只许看/)
})

await test('空白上下文不入队，也不会把已有上下文冲掉', async () => {
  const before = engine.turnContext()
  assert.equal(engine.noteTurnContext({ sessionId: 'session-c', kind: 'user', text: '   ' }), false)
  assert.equal(engine.turnContext().sessionId, before.sessionId)
  assert.ok(engine.injectionStats().query.used)
})

await test('完全无关的问句一条都不标命中', async () => {
  engine.noteTurnContext({ sessionId: 'session-d', kind: 'user', text: '今天上海天气怎么样' })
  const stats = engine.injectionStats()
  assert.equal(stats.query.hitBar, null, '分不出高低时 hitBar 设为 null')
  assert.equal(stats.text.includes('·命中'), false)
})

await test('只有一个查询词时也不标命中', async () => {
  engine.noteTurnContext({ sessionId: 'session-e', kind: 'user', text: '这首诗押韵吗' })
  const stats = engine.injectionStats()
  assert.equal(stats.text.includes('·命中'), false)
})

await test('少见的词比到处都是的词更有分量', async () => {
  // 同一句问话里既有「用户」这种满库都有的词，也有「柠檬酸」这种只在一两条里出现的词，
  // 排序应该按后者走——不然等于所有词一视同仁。
  await engine.createItem({
    layer: 'L4',
    title: '称呼习惯',
    content: '用户喜欢被叫啸春，平时直接叫名字。',
    ttlDays: 30,
    importance: 5,
  }, 'user')
  await engine.createItem({
    layer: 'L4',
    title: '水壶除垢',
    content: '电水壶结垢用柠檬酸泡一晚，第二天冲干净就行。',
    ttlDays: 30,
    importance: 5,
  }, 'user')
  engine.noteTurnContext({ sessionId: 'session-f', kind: 'user', text: '用户的柠檬酸还剩多少' })
  const stats = engine.injectionStats()
  const lines = memoryLines(stats)
  assert.match(lines[0].title, /水壶除垢/, '含罕见词的条目应排第一')
  assert.ok((lines[0].relevance ?? 0) > (lines[1].relevance ?? 0))
})

await test('同义扩展：问「多大」也能找到写着出生年份的那条', async () => {
  // 真实对话里问法和记载用词常常对不上。词表只加在查询侧，不改存进去的东西。
  await engine.createItem({
    layer: 'L2',
    title: '出生年份',
    content: '1995 年 3 月出生，属猪。',
    ttlDays: 3650,
    importance: 6,
  }, 'user')
  engine.noteTurnContext({ sessionId: 'session-g', kind: 'user', text: '我今年多大' })
  const lines = memoryLines(engine.injectionStats())
  assert.match(lines[0].title, /出生年份/, '扩展词应把只写了出生年份的条目拉上来')
})

await test('命中条目给全文，背景条目只留一行', async () => {
  engine.noteTurnContext({ sessionId: 'session-h', kind: 'user', text: 'PTY shell exited during startup 怎么办' })
  const stats = engine.injectionStats()
  const lines = memoryLines(stats)
  assert.match(stats.text, /·命中/, '这一轮应当标出命中')
  assert.ok(lines[0].chars > lines[lines.length - 1].chars, '命中条的正文预算应高于背景条')
  const background = lines[lines.length - 1]
  assert.ok(background.chars < 150, '背景条只留一行，不占预算')
})

console.log(`\n${passed} 项通过，数据目录：${store.dir}`)
