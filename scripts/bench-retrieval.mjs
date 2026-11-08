/**
 * 公开题库适配器：Ornn8/chat-memory-benchmark 的检索层评测。
 *
 * 只考「记忆检索」这一段：把人物历史逐轮灌进沙箱记忆库，到每题的截止点提问，
 * 看这题该用的证据条目有没有进注入排序、排第几。不调模型、不判语义对错，
 * 所以数字叫「检索命中率」，不能直接跟原仓库的 714 题总分对比。
 *
 * 数据源：https://github.com/Ornn8/chat-memory-benchmark （MIT）
 * 用法：
 *   node scripts/bench-retrieval.mjs                 # 全量 714 题
 *   BENCH_LIMIT=60 node scripts/bench-retrieval.mjs  # 每个考点抽样，先看趋势
 *   BENCH_DIR=D:/path/to/chat-memory-benchmark node scripts/bench-retrieval.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const BENCH = process.env.BENCH_DIR ?? 'D:/aboutAI/_bench/chat-memory-benchmark'
const DATASET = join(BENCH, 'datasets/natural-timegrid-20261101-v2')
const LIMIT = Number(process.env.BENCH_LIMIT ?? 0)
// 每条记忆合并几轮对话（1 = 一轮一条）。答案常常横跨两三轮的题，靠合并才可能进榜。
const MERGE = Math.max(1, Number(process.env.BENCH_MERGE ?? 1))

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))

const exams = readJsonl(join(DATASET, 'exam-inputs.jsonl'))
const keyById = new Map(readJsonl(join(DATASET, 'review-only/answer-key.jsonl')).map((entry) => [entry.id, entry]))

const knowledge = normalizeSettings({
  prompt: { overrideBudget: true, topN: 30, maxChars: 6000 },
})
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-bench-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const personas = [...new Set(exams.map((exam) => exam.persona))].sort()
const truncated = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

// 一个人物一个隔离库：题目只在该人物自己的历史里检索。
async function buildPersona(persona) {
  const dir = join(sandbox, persona)
  const store = createStore({ get: () => (name) => join(dir, name) }, () => {}, () => knowledge)
  const engine = await createEngine({ store, initialSettings: knowledge, getSettings: () => knowledge, log: () => {} })
  const file = exams.find((exam) => exam.persona === persona).history_file
  const turns = readJsonl(join(DATASET, file)).sort((left, right) => left['轮次'] - right['轮次'])
  return { engine, turns, imported: 0 }
}

const groupOf = (persona, turnNumber) => `t-${persona}-g${Math.floor((turnNumber - 1) / MERGE)}`

function itemsFor(persona, turns) {
  const groups = new Map()
  for (const turn of turns) {
    const id = groupOf(persona, turn['轮次'])
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(turn)
  }
  return [...groups.entries()].map(([id, list]) => ({
    id,
    layer: 'L4',
    type: 'memory',
    title: `第${list[0]['日']}天 · 第${list[0]['轮次']}${list.length > 1 ? `-${list[list.length - 1]['轮次']}` : ''}轮`,
    content: list.map((turn) => `${truncated(turn['用户消息'], 400)}\n${truncated(turn['助手回复'], 400)}`).join('\n'),
    tags: [],
    importance: 5,
    confidence: 0.8,
    status: 'active',
    freshnessPeriod: 3650,
    createdAt: list[0]['逻辑时间'],
    updatedAt: list[list.length - 1]['逻辑时间'],
    lastAccessAt: list[list.length - 1]['逻辑时间'],
    source: { kind: 'user' },
  }))
}

const results = []
const queues = new Map()
for (const exam of exams) {
  if (!queues.has(exam.persona)) queues.set(exam.persona, [])
  queues.get(exam.persona).push(exam)
}

let questionCount = 0
for (const persona of personas) {
  const state = await buildPersona(persona)
  const queue = queues.get(persona).sort((left, right) => left.cutoff_turn - right.cutoff_turn)
  for (const exam of queue) {
    if (LIMIT > 0 && questionCount >= LIMIT) break
    questionCount += 1
    // 只让记忆看到截止点之前的历史。
    const upto = state.turns.filter((turn) => turn['轮次'] <= exam.cutoff_turn)
    // 合并模式只在整组齐了才灌，避免同一组被拆成两条。
    const ready = Math.floor((upto.length - state.imported) / MERGE) * MERGE
    if (ready > 0) {
      const fresh = upto.slice(state.imported, state.imported + ready)
      await state.engine.importData({ items: itemsFor(persona, fresh) }, 'merge')
      state.imported += ready
    }
    state.engine.noteTurnContext({ sessionId: `exam-${exam.id}`, kind: 'user', text: exam.question })
    const now = Date.parse(exam.now)
    const stats = state.engine.injectionStats(now)
    const anchorIds = new Set((keyById.get(exam.id)?.anchors ?? []).map((anchor) => groupOf(persona, anchor.last_turn)))
    const memories = stats.lines.filter((line) => line.source === 'memory')
    let rank = Infinity
    let marked = false
    let falseMark = 0
    const bar = typeof stats.query?.hitBar === 'number' ? stats.query.hitBar : Infinity
    for (let index = 0; index < memories.length; index += 1) {
      const line = memories[index]
      const isMarked = (line.relevance ?? 0) >= bar && (line.matched ?? 0) >= 2
      const isAnchor = anchorIds.has(line.id)
      if (isAnchor) {
        if (index < rank) rank = index
        if (isMarked) marked = true
      } else if (isMarked) {
        falseMark += 1
      }
    }
    results.push({
      id: exam.id,
      persona,
      rank,
      marked,
      falseMark,
      tags: keyById.get(exam.id)?.content_tags ?? [],
      tokens: stats.query?.tokens ?? 0,
      total: memories.length,
      question: exam.question,
    })
  }
}

const within = (n) => results.filter((result) => result.rank < n).length
const pct = (value) => `${((value / results.length) * 100).toFixed(1)}%`
const missing = results.filter((result) => result.rank === Infinity).length
const markedCount = results.filter((result) => result.marked).length
const falseMarks = results.reduce((sum, result) => sum + result.falseMark, 0)

console.log(`题目 ${results.length} 道｜每条合并 ${MERGE} 轮｜候选条目中位数 ${results.map((r) => r.total).sort((a, b) => a - b)[Math.floor(results.length / 2)]}`)
console.log(`检索命中：@1 ${within(1)} (${pct(within(1))})  @3 ${within(3)} (${pct(within(3))})  @10 ${within(10)} (${pct(within(10))})  进榜 ${results.length - missing} (${pct(results.length - missing)})`)
console.log(`带「命中」标记且命中正确：${markedCount} (${pct(markedCount)})｜标错（非证据条也被标）：${falseMarks} 条（占 ${((falseMarks / Math.max(1, results.length)) * 100).toFixed(1)}%）｜未进榜 ${missing}`)

const byTag = new Map()
for (const result of results) {
  for (const tag of result.tags.length > 0 ? result.tags : ['未标注']) {
    if (!byTag.has(tag)) byTag.set(tag, [])
    byTag.get(tag).push(result)
  }
}
const rows = [...byTag.entries()]
  .map(([tag, list]) => ({
    tag,
    total: list.length,
    at1: (list.filter((r) => r.rank < 1).length / list.length) * 100,
    at10: (list.filter((r) => r.rank < 10).length / list.length) * 100,
    miss: list.filter((r) => r.rank === Infinity).length,
  }))
  .sort((left, right) => left.at1 - right.at1)
console.log('\n考点（按 @1 升序，只看最弱的 12 类）：')
for (const row of rows.slice(0, 12)) {
  console.log(`  ${row.tag.padEnd(12, '　')} 题 ${String(row.total).padStart(3)}  @1 ${row.at1.toFixed(0).padStart(3)}%  @10 ${row.at10.toFixed(0).padStart(3)}%  未进榜 ${row.miss}`)
}

const worst = results.filter((result) => result.rank === Infinity).slice(0, 8)
if (worst.length > 0) {
  console.log('\n未进榜示例：')
  for (const item of worst) console.log(`  ${item.id}｜${item.question}`)
}

// 详细结果落盘，便于逐题归因（路径可用 BENCH_OUT 覆盖）。
const outFile = process.env.BENCH_OUT ?? join(tmpdir(), 'dsh-bench-results.jsonl')
writeFileSync(outFile, results.map((result) => JSON.stringify(result)).join('\n'))
console.log(`\n明细已写入 ${outFile}`)
