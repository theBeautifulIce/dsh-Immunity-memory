/**
 * 未进榜题目的逐题归因（配套 bench-retrieval.mjs 使用）。
 *
 * 只回答一个问题：这些题为什么一条证据都没进注入榜。
 * 判断依据是「查询词和证据条目在词面上有没有交集」，不重跑检索，算的是上限：
 *   - 一个共同词都没有 → 换说法/指代，词面排序再调也救不回来（要靠语义或图）；
 *   - 有共同词、但每个词在全库都太常见（df 超过 35%）→ 会被 selectQueryTokens 丢掉；
 *   - 有少见共同词却没进榜 → 排序或预算问题，这类才是能继续调的。
 *
 * 用法：
 *   node scripts/bench-missing.mjs                       # 读默认结果文件
 *   BENCH_OUT=D:/x.jsonl node scripts/bench-missing.mjs  # 指定结果文件
 *   BENCH_DIR=D:/path/to/chat-memory-benchmark node scripts/bench-missing.mjs
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tokenize, searchableText } from '../packages/memory-plugin/lib/text.js'

const BENCH = process.env.BENCH_DIR ?? 'D:/aboutAI/_bench/chat-memory-benchmark'
const DATASET = join(BENCH, 'datasets/natural-timegrid-20261101-v2')
const OUT = process.env.BENCH_OUT ?? join(tmpdir(), 'dsh-bench-results.jsonl')
const SHOW = Math.max(1, Number(process.env.BENCH_SHOW ?? 42))

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))

const results = readJsonl(OUT)
const exams = readJsonl(join(DATASET, 'exam-inputs.jsonl'))
const examById = new Map(exams.map((exam) => [exam.id, exam]))
const keyById = new Map(readJsonl(join(DATASET, 'review-only/answer-key.jsonl')).map((entry) => [entry.id, entry]))

const histories = new Map()
function historyOf(exam) {
  if (!histories.has(exam.persona)) {
    histories.set(exam.persona, readJsonl(join(DATASET, exam.history_file))
      .sort((left, right) => left['轮次'] - right['轮次']))
  }
  return histories.get(exam.persona)
}

const groupOf = (persona, turnNumber) => `t-${persona}-g${Math.floor((turnNumber - 1) / 1)}`

function itemText(turn) {
  return searchableText({
    title: `第${turn['日']}天 · 第${turn['轮次']}轮`,
    content: `${String(turn['用户消息'] ?? '').slice(0, 400)}\n${String(turn['助手回复'] ?? '').slice(0, 400)}`,
    tags: [],
  })
}

// JSON 落盘会把 Infinity 写成 null，这里两种都算未进榜。
const missing = results.filter((result) => result.rank === null || result.rank === Infinity)
const buckets = new Map()
const rows = []
for (const result of missing) {
  const exam = examById.get(result.id)
  const key = keyById.get(result.id)
  if (exam === undefined || key === undefined) continue
  const turns = historyOf(exam).filter((turn) => turn['轮次'] <= exam.cutoff_turn)
  const anchors = new Map()
  for (const anchor of key.anchors ?? []) {
    const id = groupOf(exam.persona, anchor.last_turn)
    anchors.set(id, turns.find((turn) => turn['轮次'] === anchor.last_turn))
  }
  const queryTokens = [...tokenize(result.question)]
  const df = new Map()
  const visible = []
  for (const turn of turns) {
    const tokens = new Set(tokenize(itemText(turn)))
    visible.push(tokens)
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1)
  }
  const ceiling = Math.max(2, Math.floor(turns.length * 0.35))
  let overlap = 0
  let rareOverlap = 0
  for (const [id, turn] of anchors) {
    if (turn === undefined) continue
    const tokens = new Set(tokenize(itemText(turn)))
    for (const token of queryTokens) {
      if (!tokens.has(token)) continue
      overlap += 1
      if ((df.get(token) ?? 0) <= ceiling) rareOverlap += 1
    }
    void id
  }
  const verdict = rareOverlap === 0
    ? '没有少见共同词（换说法/指代，词面够不着）'
    : '有少见共同词却没进榜（排序或预算问题）'
  if (!buckets.has(verdict)) buckets.set(verdict, [])
  buckets.get(verdict).push(result.id)
  rows.push({ id: result.id, question: result.question, tokens: queryTokens.length, overlap, rareOverlap, verdict, candidates: result.total })
}

for (const [verdict, ids] of [...buckets.entries()].sort((left, right) => right[1].length - left[1].length)) {
  console.log(`${verdict}：${ids.length} 题`)
  console.log(`  ${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ' …' : ''}`)
}
console.log('')
for (const row of rows.slice(0, SHOW)) {
  console.log(`${row.id}｜候选 ${row.candidates}｜查询词 ${row.tokens}｜共同词 ${row.overlap}（少见 ${row.rareOverlap}）｜${row.question}`)
}
