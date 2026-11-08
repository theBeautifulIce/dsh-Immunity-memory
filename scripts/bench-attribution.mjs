/**
 * 未进榜归因：714 题里没进注入榜（或排得靠后）的那些，究竟输在哪一步。
 *
 * 只做诊断，不改任何记忆/排序逻辑。对每道题算两件事：
 *   1) 证据轮自己的字面覆盖率 —— 题面里有效的查询词，有几个真的出现在那一轮里；
 *   2) 邻近轮（±1、±2）能补上多少 —— 用来区分「单轮缺词」还是「换了一种说法」。
 *
 * 用法：
 *   node scripts/bench-attribution.mjs
 *   BENCH_DIR=D:/path/to/chat-memory-benchmark node scripts/bench-attribution.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'
import { tokenize } from '../packages/memory-plugin/lib/text.js'

const BENCH = process.env.BENCH_DIR ?? 'D:/aboutAI/_bench/chat-memory-benchmark'
const DATASET = join(BENCH, 'datasets/natural-timegrid-20261101-v2')
const DF_RATIO = 0.35

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))

const exams = readJsonl(join(DATASET, 'exam-inputs.jsonl'))
const keyById = new Map(readJsonl(join(DATASET, 'review-only/answer-key.jsonl')).map((entry) => [entry.id, entry]))

const knowledge = normalizeSettings({ prompt: { overrideBudget: true, topN: 30, maxChars: 6000 } })
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-attrib-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const personas = [...new Set(exams.map((exam) => exam.persona))].sort()
const truncated = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}
const itemId = (persona, turn) => `t-${persona}-${turn}`

const histories = new Map()
for (const persona of personas) {
  const file = exams.find((exam) => exam.persona === persona).history_file
  const turns = readJsonl(join(DATASET, file)).sort((left, right) => left['轮次'] - right['轮次'])
  histories.set(persona, new Map(turns.map((turn) => [turn['轮次'], turn])))
}

/** 粗略复刻 selectQueryTokens 的口径：丢掉过半条目都有的泛词，按 df 升序取前 32。 */
function queryTokens(question, persona) {
  const history = histories.get(persona)
  const df = new Map()
  for (const turn of history.values()) {
    for (const token of new Set(tokenize(`${turn['用户消息']} ${turn['助手回复']}`))) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const ceiling = Math.max(2, Math.floor(history.size * DF_RATIO))
  const kept = [...new Set(tokenize(question))].filter((token) => {
    const seen = df.get(token) ?? 0
    return seen > 0 && seen <= ceiling
  })
  kept.sort((left, right) => (df.get(left) ?? 0) - (df.get(right) ?? 0))
  return { tokens: kept.slice(0, 32), df }
}

const turnTokens = (turn) => new Set(tokenize(`${turn?.['用户消息'] ?? ''} ${turn?.['助手回复'] ?? ''}`))

function itemsFor(persona, turns) {
  return turns.map((turn) => ({
    id: itemId(persona, turn['轮次']),
    layer: 'L4',
    type: 'memory',
    title: `第${turn['日']}天 · 第${turn['轮次']}轮`,
    content: `${truncated(turn['用户消息'], 400)}\n${truncated(turn['助手回复'], 400)}`,
    tags: [],
    importance: 5,
    confidence: 0.8,
    status: 'active',
    freshnessPeriod: 3650,
    createdAt: turn['逻辑时间'],
    updatedAt: turn['逻辑时间'],
    lastAccessAt: turn['逻辑时间'],
    source: { kind: 'user' },
  }))
}

async function buildPersona(persona) {
  const dir = join(sandbox, persona)
  const store = createStore({ get: () => (name) => join(dir, name) }, () => {}, () => knowledge)
  const engine = await createEngine({ store, initialSettings: knowledge, getSettings: () => knowledge, log: () => {} })
  const file = exams.find((exam) => exam.persona === persona).history_file
  const turns = readJsonl(join(DATASET, file)).sort((left, right) => left['轮次'] - right['轮次'])
  return { engine, turns, imported: 0 }
}

const rows = []
for (const persona of personas) {
  const state = await buildPersona(persona)
  const queue = exams.filter((exam) => exam.persona === persona).sort((left, right) => left.cutoff_turn - right.cutoff_turn)
  for (const exam of queue) {
    const upto = state.turns.filter((turn) => turn['轮次'] <= exam.cutoff_turn)
    if (upto.length > state.imported) {
      await state.engine.importData({ items: itemsFor(persona, upto.slice(state.imported)) }, 'merge')
      state.imported = upto.length
    }
    state.engine.noteTurnContext({ sessionId: `exam-${exam.id}`, kind: 'user', text: exam.question })
    const stats = state.engine.injectionStats(Date.parse(exam.now))
    const anchorTurns = (keyById.get(exam.id)?.anchors ?? []).map((anchor) => anchor.last_turn)
    const anchorIds = new Set(anchorTurns.map((turn) => itemId(persona, turn)))
    const memories = stats.lines.filter((line) => line.source === 'memory')
    let rank = Infinity
    for (let index = 0; index < memories.length; index += 1) {
      if (anchorIds.has(memories[index].id)) {
        rank = index
        break
      }
    }

    const { tokens } = queryTokens(exam.question, persona)
    const history = histories.get(persona)
    let best = { coverage: -1, turn: null, onlyIn: new Set() }
    for (const turnNumber of anchorTurns) {
      const own = turnTokens(history.get(turnNumber))
      const ownHits = tokens.filter((token) => own.has(token))
      const coverage = tokens.length === 0 ? 0 : ownHits.length / tokens.length
      if (coverage > best.coverage) best = { coverage, turn: turnNumber, ownHits }
    }
    const neighbor = new Set()
    for (const turnNumber of anchorTurns) {
      for (const delta of [-2, -1, 1, 2]) {
        const turn = history.get(turnNumber + delta)
        if (turn === undefined) continue
        for (const token of turnTokens(turn)) neighbor.add(token)
      }
    }
    const ownSet = new Set(best.ownHits ?? [])
    const rescued = tokens.filter((token) => !ownSet.has(token) && neighbor.has(token))

    let bucket
    if (rank < 3) bucket = '已进前三（不算输）'
    else if (rank < 30) bucket = '进了榜但排在后面'
    else if (best.coverage >= 0.34) bucket = '词都对上了却没进榜（候选/过滤问题）'
    else if (best.coverage > 0 && rescued.length > 0) bucket = '单轮缺词，邻轮才有'
    else if (best.coverage === 0 && rescued.length > 0) bucket = '本轮的词题面一个都没有，全靠邻轮'
    else bucket = '字面完全对不上（同义/抽象/指代）'

    rows.push({
      id: exam.id,
      persona,
      rank,
      coverage: best.coverage,
      rescued: rescued.length,
      tokens: tokens.length,
      bucket,
      question: exam.question,
      anchorTurns,
    })
  }
}

const total = rows.length
const pct = (value) => `${((value / total) * 100).toFixed(1)}%`
const buckets = new Map()
for (const row of rows) {
  if (!buckets.has(row.bucket)) buckets.set(row.bucket, [])
  buckets.get(row.bucket).push(row)
}

console.log(`题目 ${total} 道｜查询词中位数 ${rows.map((row) => row.tokens).sort((a, b) => a - b)[Math.floor(total / 2)]}\n`)
for (const [bucket, list] of [...buckets.entries()].sort((left, right) => right[1].length - left[1].length)) {
  const avgCoverage = list.reduce((sum, row) => sum + row.coverage, 0) / list.length
  console.log(`${String(list.length).padStart(3)} 道 (${pct(list.length)})  ${bucket}｜字面覆盖率均值 ${(avgCoverage * 100).toFixed(0)}%`)
}

const missing = rows.filter((row) => row.rank === Infinity)
const near = missing.filter((row) => row.coverage > 0 && row.rescued > 0)
const none = missing.filter((row) => row.coverage === 0)
console.log(`\n未进榜 ${missing.length} 道：其中「本轮有词但不够」${near.length} 道、「本轮一个词都对不上」${none.length} 道`)

console.log('\n—— 未进榜样例（前 12）——')
for (const row of missing.slice(0, 12)) {
  console.log(`  [${row.bucket}] ${row.id}  覆盖 ${(row.coverage * 100).toFixed(0)}% 邻轮可补 ${row.rescued}`)
  console.log(`      题：${row.question.slice(0, 90)}`)
}

const filtered = buckets.get('词都对上了却没进榜（候选/过滤问题）') ?? []
if (filtered.length > 0) {
  console.log(`\n—— 字面对上了却没进榜的 ${filtered.length} 道全列 ——`)
  for (const row of filtered) {
    console.log(`  ${row.id}  覆盖 ${(row.coverage * 100).toFixed(0)}%  查询词 ${row.tokens}  锚点轮 ${row.anchorTurns.join(',')}`)
    console.log(`      题：${row.question.slice(0, 90)}`)
  }
}
