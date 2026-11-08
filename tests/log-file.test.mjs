/**
 * 结构化日志（lib/log-file.js）的测试：一行一 JSON、按大小轮转、只留最新几份。
 *
 * 运行：node tests/log-file.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LOG_LIMITS, createFileLogger } from '../packages/memory-plugin/lib/log-file.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-log-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

let passed = 0
function test(title, run) {
  try {
    run()
    passed += 1
    console.log(`  ok  ${title}`)
  } catch (error) {
    console.error(`  FAIL ${title}`)
    throw error
  }
}

const at = (iso) => () => new Date(iso)

await test('每行是一个带时间、级别和事件名的 JSON 对象', () => {
  const dir = join(sandbox, 'plain')
  const logger = createFileLogger({ dir, now: at('2026-11-08T09:30:00.000Z') })
  assert.equal(logger.write('info', 'log', { text: '记忆库已就绪' }), true)
  assert.equal(logger.write('warn', 'log', { text: '原生核心不可用' }), true)
  const lines = readFileSync(logger.path(), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.ts, '2026-11-08T09:30:00.000Z')
  assert.equal(first.level, 'info')
  assert.equal(first.event, 'log')
  assert.equal(first.text, '记忆库已就绪')
  assert.equal(JSON.parse(lines[1]).level, 'warn')
  assert.equal(logger.path().endsWith('memory-2026-11-08.jsonl'), true)
})

await test('单文件写满后滚动成同一天的 .1，并从空文件继续', () => {
  const dir = join(sandbox, 'rotate')
  const logger = createFileLogger({ dir, maxBytes: 220, keep: 20, now: at('2026-11-08T10:00:00.000Z') })
  for (let index = 0; index < 12; index += 1) {
    assert.equal(logger.write('info', 'log', { text: `第 ${index} 行，凑一点长度让它早点写满` }), true)
  }
  const names = readdirSync(dir).sort()
  assert.equal(names.includes('memory-2026-11-08.jsonl'), true)
  assert.equal(names.includes('memory-2026-11-08.1.jsonl'), true)
  const rotated = readFileSync(join(dir, 'memory-2026-11-08.1.jsonl'), 'utf8').trim().split('\n')
  assert.ok(rotated.length >= 1)
  for (const line of rotated) JSON.parse(line)
  // 滚动过之后当前文件的字节数应当明显小于上限总量。
  assert.ok(readFileSync(logger.path(), 'utf8').length <= 220)
})

await test('只保留最新 keep 份，旧的自动删掉', () => {
  const dir = join(sandbox, 'prune')
  const logger = createFileLogger({ dir, maxBytes: 120, keep: 3, now: at('2026-11-08T11:00:00.000Z') })
  for (let index = 0; index < 30; index += 1) logger.write('info', 'log', { text: `第 ${index} 条足够长的日志内容` })
  const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  assert.ok(names.length <= 3, `应当最多 3 份，实际 ${names.join(', ')}`)
  assert.ok(names.includes('memory-2026-11-08.jsonl'), '当天最新一份必须还在')
})

await test('跨天自动换文件，旧文件按 keep 收敛', () => {
  const dir = join(sandbox, 'day')
  const first = createFileLogger({ dir, keep: 4, now: at('2026-11-07T23:59:00.000Z') })
  first.write('info', 'log', { text: '昨天最后一条' })
  const second = createFileLogger({ dir, keep: 4, now: at('2026-11-08T00:01:00.000Z') })
  second.write('info', 'log', { text: '今天第一条' })
  const names = readdirSync(dir).sort()
  assert.deepEqual(names, ['memory-2026-11-07.jsonl', 'memory-2026-11-08.jsonl'])
  assert.equal(second.path(), join(dir, 'memory-2026-11-08.jsonl'))
})

await test('目录写不了也不抛，只是返回 false', () => {
  const dir = join(sandbox, 'blocked')
  writeFileSync(dir, '这是一个文件，不是目录')
  const logger = createFileLogger({ dir })
  assert.equal(logger.write('info', 'log', { text: '写不进去' }), false)
  assert.equal(logger.path(), undefined)
})

await test('默认上限是 2MB、8 份', () => {
  assert.deepEqual(LOG_LIMITS, { maxBytes: 2 * 1024 * 1024, keep: 8 })
})
