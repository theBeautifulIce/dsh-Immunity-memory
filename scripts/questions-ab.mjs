/**
 * 「能回答什么问题（questions）」字段的诚实 A/B。
 *
 * 为什么要单独做这一步：questions 是写入时由模型替未来的人写好的问法，
 * 如果拿考试题去反推这句话，等于把答案抄进索引，数字会好看但没意义。
 * 所以流程拆成两步：
 *
 *   1) sample：只输出「轮到什么内容」，不出题面，由人（或另一个模型）
 *      看着原文写这句话 —— 相当于模拟真实的写入现场。
 *   2) eval：把写好的 questions 挂回对应轮次，与不带 questions 的基线
 *      跑同一批题，比 recall@k。
 *
 * 用法：
 *   node scripts/questions-ab.mjs sample 40
 *   （照 %TEMP%\questions-sample.json 里的内容写 %TEMP%\questions-authored.json）
 *   node scripts/questions-ab.mjs eval
 *
 * authored 文件格式：{ "P01|123": ["这周末什么时候开饭", "聚餐几点"] }
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const BENCH = process.env.BENCH_DIR ?? 'D:/aboutAI/_bench/chat-memory-benchmark'
const DATASET = join(BENCH, 'datasets/natural-timegrid-20261101-v2')
const SAMPLE_FILE = join(tmpdir(), 'questions-sample.json')
const AUTHORED_FILE = join(tmpdir(), 'questions-authored.json')

const mode = process.argv[2] ?? 'sample'
const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))

const exams = readJsonl(join(DATASET, 'exam-inputs.jsonl'))
const keyById = new Map(readJsonl(join(DATASET, 'review-only/answer-key.jsonl')).map((entry) => [entry.id, entry]))
const knowledge = normalizeSettings({ prompt: { overrideBudget: true, topN: 30, maxChars: 6000 } })

const truncated = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}
const turnKey = (persona, turn) => `${persona}|${turn}`

/** 只取「证据落在单轮」的题：这样 questions 只能挂在唯一那条上，A/B 干净。 */
function singleAnchorExams() {
  return exams.filter((exam) => (keyById.get(exam.id)?.anchors ?? []).length === 1)
}

function historyFor(persona) {
  const file = exams.find((exam) => exam.persona === persona).history_file
  return new Map(readJsonl(join(DATASET, file)).map((turn) => [turn['轮次'], turn]))
}

if (mode === 'sample') {
  const want = Number(process.argv[3] ?? 40)
  const pool = singleAnchorExams()
  // 按人物轮转取样，避免全挤在同一个人身上。
  const byPersona = new Map()
  for (const exam of pool) {
    if (!byPersona.has(exam.persona)) byPersona.set(exam.persona, [])
    byPersona.get(exam.persona).push(exam)
  }
  const picked = []
  let cursor = 0
  while (picked.length < want) {
    let added = false
    for (const list of byPersona.values()) {
      if (picked.length >= want) break
      const next = list[cursor]
      if (next === undefined) continue
      picked.push(next)
      added = true
    }
    if (!added) break
    cursor += 1
  }
  const sample = []
  const seen = new Set()
  for (const exam of picked) {
    const turn = (keyById.get(exam.id)?.anchors ?? [])[0].last_turn
    const key = turnKey(exam.persona, turn)
    if (seen.has(key)) continue
    seen.add(key)
    const history = historyFor(exam.persona)
    const row = history.get(turn)
    if (row === undefined) continue
    sample.push({
      key,
      persona: exam.persona,
      turn,
      examId: exam.id,
      text: `${truncated(row['用户消息'], 320)}\n${truncated(row['助手回复'], 320)}`,
    })
  }
  writeFileSync(SAMPLE_FILE, JSON.stringify(sample, null, 2), 'utf8')
  for (const entry of sample) {
    console.log(`--- ${entry.key}（${entry.examId}）`)
    console.log(entry.text)
  }
  console.log(`\n共 ${sample.length} 条，已写入 ${SAMPLE_FILE}`)
  console.log(`请按内容写 ${AUTHORED_FILE}，格式：{ "P01|123": ["问法1", "问法2"] }`)
  process.exit(0)
}

if (!existsSync(AUTHORED_FILE)) {
  console.error(`找不到 ${AUTHORED_FILE}，先跑 sample 再写问法。`)
  process.exit(1)
}
const authored = JSON.parse(readFileSync(AUTHORED_FILE, 'utf8'))
const sample = existsSync(SAMPLE_FILE) ? JSON.parse(readFileSync(SAMPLE_FILE, 'utf8')) : []
const sampleByExam = new Map(sample.map((entry) => [entry.examId, entry]))
const authoredKeys = new Set(Object.keys(authored))
// 不只看取样那一题：凡是锚点落在「已写问法」轮次上的单锚点题都纳入，
// 同一轮次往往在多天考试里被考到好几次，这样 n 更大、结论更稳。
const targetExams = singleAnchorExams().filter((exam) => {
  const anchor = (keyById.get(exam.id)?.anchors ?? [])[0]
  if (anchor === undefined) return false
  return authoredKeys.has(turnKey(exam.persona, anchor.last_turn))
})
if (targetExams.length === 0) {
  console.error('样品里的题已不在题库中，先重新 sample。')
  process.exit(1)
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-qab-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

function itemsFor(persona, turns, questionsByTurn) {
  return turns.map((turn) => {
    const key = turnKey(persona, turn['轮次'])
    const item = {
      id: `t-${persona}-${turn['轮次']}`,
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
    }
    if (questionsByTurn.size > 0 && questionsByTurn.has(key)) item.questions = questionsByTurn.get(key)
    return item
  })
}

async function run(withQuestions) {
  const questionsByTurn = new Map(Object.entries(authored))
  const outcomes = []
  const personas = [...new Set(targetExams.map((exam) => exam.persona))]
  for (const persona of personas) {
    const dir = join(sandbox, `${persona}-${withQuestions ? 'q' : 'base'}`)
    const store = createStore({ get: () => (name) => join(dir, name) }, () => {}, () => knowledge)
    const engine = await createEngine({ store, initialSettings: knowledge, getSettings: () => knowledge, log: () => {} })
    const history = [...historyFor(persona).values()].sort((left, right) => left['轮次'] - right['轮次'])
    let imported = 0
    for (const exam of targetExams.filter((entry) => entry.persona === persona).sort((left, right) => left.cutoff_turn - right.cutoff_turn)) {
      const upto = history.filter((turn) => turn['轮次'] <= exam.cutoff_turn)
      if (upto.length > imported) {
        const fresh = upto.slice(imported)
        await engine.importData({ items: itemsFor(persona, fresh, withQuestions ? questionsByTurn : new Map()) }, 'merge')
        imported = upto.length
      }
      engine.noteTurnContext({ sessionId: `exam-${exam.id}`, kind: 'user', text: exam.question })
      const stats = engine.injectionStats(Date.parse(exam.now))
      const anchor = `t-${persona}-${keyById.get(exam.id).anchors[0].last_turn}`
      const memories = stats.lines.filter((line) => line.source === 'memory')
      const index = memories.findIndex((line) => line.id === anchor)
      outcomes.push({ id: exam.id, rank: index < 0 ? Infinity : index })
    }
  }
  return outcomes
}

const baseline = await run(false)
const withQ = await run(true)
const count = (rows, n) => rows.filter((row) => row.rank < n).length
const pct = (value) => `${((value / baseline.length) * 100).toFixed(1)}%`
const keyOf = new Map(baseline.map((row) => [row.id, row]))

console.log(`样品 ${baseline.length} 题（单锚点，问法只从原文写）｜挂上 questions 的轮次 ${Object.keys(authored).length} 条\n`)
console.log(`基线     @1 ${count(baseline, 1)} (${pct(count(baseline, 1))})  @3 ${count(baseline, 3)} (${pct(count(baseline, 3))})  @10 ${count(baseline, 10)} (${pct(count(baseline, 10))})`)
console.log(`带问法   @1 ${count(withQ, 1)} (${pct(count(withQ, 1))})  @3 ${count(withQ, 3)} (${pct(count(withQ, 3))})  @10 ${count(withQ, 10)} (${pct(count(withQ, 10))})`)

const improved = withQ.filter((row) => row.rank < (keyOf.get(row.id)?.rank ?? Infinity))
const worsened = withQ.filter((row) => row.rank > (keyOf.get(row.id)?.rank ?? Infinity))
console.log(`\n变好 ${improved.length} 题｜变差 ${worsened.length} 题`)
for (const row of improved) console.log(`  ↑ ${row.id}  ${keyOf.get(row.id).rank + 1} → ${row.rank + 1}`)
for (const row of worsened) console.log(`  ↓ ${row.id}  ${keyOf.get(row.id).rank + 1} → ${row.rank + 1}`)
