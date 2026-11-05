/**
 * 原生计算核心测试（Rust 二进制 + JS 兜底）。
 *
 * 运行前需要先构建：node scripts/build-native.mjs
 * 运行：node tests/native.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { createNativeCore, resolveBinary, platformTag } from '../packages/memory-plugin/lib/native.js'

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

const binary = resolveBinary()
console.log(`平台 ${platformTag()}，二进制：${binary}`)
assert.ok(existsSync(binary), `缺少原生核心，请先运行 node scripts/build-native.mjs（期望 ${binary}）`)

const core = createNativeCore({})

await test('握手与健康信息', async () => {
  const health = core.health()
  assert.equal(health.fallback, true, '启动前应处于未启动状态')
  // 触发一次调用，让进程起来
  const scores = await core.cosine(Float32Array.from([1, 0, 0]), Float32Array.from([1, 0, 0, 0, 1, 0]), 2, 3)
  assert.equal(scores.length, 2)
  const after = core.health()
  assert.equal(after.available, true)
  assert.equal(after.fallback, false)
  assert.ok(after.version.length > 0)
})

await test('批量余弦与 JS 结果一致', async () => {
  const query = Float32Array.from([0.6, 0.8, 0])
  const matrix = Float32Array.from([0.6, 0.8, 0, 0, 1, 0, 1, 0, 0])
  const scores = await core.cosine(query, matrix, 3, 3)
  assert.ok(Math.abs(scores[0] - 1) < 1e-5, `第一条应完全相似，实际 ${scores[0]}`)
  assert.ok(Math.abs(scores[1] - 0.8) < 1e-5)
  assert.ok(Math.abs(scores[2] - 0.6) < 1e-5)
})

await test('批量重要性：新且常访问的分数更高', async () => {
  const now = Math.floor(Date.now() / 1000)
  const scores = await core.importance([
    { createdAt: now - 3600, lastAccessAt: now - 60, accessCount: 9, relatedCount: 10 },
    { createdAt: now - 86400 * 365, lastAccessAt: now - 86400 * 365, accessCount: 0, relatedCount: 0 },
  ], now)
  assert.ok(scores[0] > 0.7, `活跃条目应高分，实际 ${scores[0]}`)
  assert.ok(scores[1] < 0.3, `陈旧条目应低分，实际 ${scores[1]}`)
})

await test('去重：相同 token 集合返回一对', async () => {
  const pairs = await core.dedupe([
    { id: 'a', tokens: ['pnpm', '构建', '构建 pnpm'] },
    { id: 'b', tokens: ['pnpm', '构建', '构建 pnpm'] },
    { id: 'c', tokens: ['完全不同', '的词汇'] },
  ], 0.8)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].a, 'a')
  assert.equal(pairs[0].b, 'b')
  assert.ok(pairs[0].score > 0.99)
})

await test('相似度查询', async () => {
  const result = await core.similar(['alpha', 'beta'], [
    { id: 'x', tokens: ['alpha', 'beta'] },
    { id: 'y', tokens: ['gamma'] },
  ])
  const byId = Object.fromEntries(result.map((entry) => [entry.id, entry.score]))
  assert.equal(byId.x, 1)
  assert.equal(byId.y, 0)
})

await test('二进制缺失时自动退回 JS 计算', async () => {
  const previous = process.env.DSH_MEMORY_CORE
  process.env.DSH_MEMORY_CORE = `${binary}.definitely-missing`
  const fallback = createNativeCore({})
  try {
    const scores = await fallback.cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0, 1]), 2, 2)
    assert.equal(scores.length, 2)
    assert.ok(Math.abs(scores[0] - 1) < 1e-6)
    assert.ok(Math.abs(scores[1] - 0) < 1e-6)
    assert.equal(fallback.health().available, false)
  } finally {
    fallback.close()
    if (previous === undefined) delete process.env.DSH_MEMORY_CORE
    else process.env.DSH_MEMORY_CORE = previous
  }
})

core.close()
console.log(`\n${passed} 项通过`)
