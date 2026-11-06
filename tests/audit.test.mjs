/**
 * 记忆审计钩子的纯函数与门控测试，不依赖 DSH 运行时。
 *
 * 运行：node tests/audit.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { applySettingsPatch, normalizeSettings } from '../packages/memory-plugin/lib/settings.js'
import { createAuditHook, parseAuditVerdict, summarizeUsage } from '../packages/memory-plugin/lib/audit.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-audit-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

const log = () => {}
const ref = { engine: null }
const ctx = { get: () => (name) => join(sandbox, name) }
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

const userEvent = {
  type: 'user/message',
  data: {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '我们统一使用 pnpm 10，别再混用 npm。' }],
  },
}
const backgroundEvent = {
  type: 'user/message',
  data: {
    role: 'user',
    source: { kind: 'plugin', plugin: 'dsh-subagent' },
    content: [{ type: 'text', text: 'Background subagent finished and will do no further work.' }],
  },
}

function fakeAgent() {
  return {
    session: {
      snapshotEvents: () => [
        userEvent,
        backgroundEvent,
        { type: 'assistant/message', usage: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 5 } },
      ],
    },
  }
}

function fakeSubagents(verdict) {
  const calls = []
  return {
    calls,
    service: {
      startActivation: async (spec) => {
        calls.push({ provider: spec.provider, label: spec.label, request: spec.request, delivery: spec.delivery })
        return {
          localAgent: {
            session: {
              snapshotEvents: () => [{ type: 'assistant/message', usage: { inputTokens: 70, outputTokens: 20, cacheReadTokens: 5 } }],
            },
          },
          result: Promise.resolve({ structured: verdict, output: [], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
  }
}

/** 模拟真实运行时：startActivation 只返回 childId/result，没有 localAgent。 */
function persistentSubagents(verdict, { usage, openError } = {}) {
  return {
    service: {
      startActivation: async () => ({
        childId: 'child-audit-1',
        result: Promise.resolve({ structured: verdict, output: [], stopReason: 'completed' }),
        dispose: async () => {},
      }),
      ctx: {
        get: (name) => name === 'sessionPersistence'
          ? {
              open: async () => {
                if (openError) throw openError
                return {
                  read: async () => ({ events: [{ type: 'assistant/message', data: { usage } }] }),
                  close: async () => {},
                }
              },
            }
          : undefined,
      },
    },
  }
}

await test('审计 verdict 解析兼容对象、代码围栏和无效输出', async () => {
  assert.deepEqual(parseAuditVerdict({ verdict: 'approve', confidence: 0.8, reason: 'ok' }), {
    verdict: 'approve', confidence: 0.8, reason: 'ok', targetId: null,
  })
  const fenced = parseAuditVerdict('```json\n{"verdict":"reject","confidence":0.95,"reason":"与用户原话矛盾"}\n```')
  assert.equal(fenced.verdict, 'reject')
  assert.equal(fenced.confidence, 0.95)
  const invalid = parseAuditVerdict('看起来没问题')
  assert.equal(invalid.verdict, 'needs_user')
  assert.equal(invalid.confidence, 0)
})

await test('usage 汇总按字段累加', async () => {
  const usage = summarizeUsage([
    { type: 'assistant/message', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'assistant/message', usage: { inputTokens: 5, outputTokens: 1, cacheWriteTokens: 3 } },
  ])
  assert.deepEqual(usage, {
    inputTokens: 15,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 3,
    totalTokens: 21,
  })
})

await test('usage 汇总兼容会话事件的 data.usage', async () => {
  const usage = summarizeUsage([
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 7 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 10, cacheWriteTokens: 3 } } },
  ])
  assert.deepEqual(usage, {
    inputTokens: 150,
    outputTokens: 30,
    cacheReadTokens: 7,
    cacheWriteTokens: 3,
    totalTokens: 190,
  })
})

await test('批准候选会放行工具并记录累计 token', async () => {
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), {
    hook: { enabled: true, enforce: true, minConfidence: 0.7, timeoutSeconds: 10 },
  }))
  const fake = fakeSubagents({ verdict: 'approve', confidence: 0.95, reason: '来源明确' })
  const hook = createAuditHook({ engine, getSubagents: () => fake.service, log })
  let nextCalled = 0
  const decision = await hook.gate({
    name: 'memory_write',
    callId: 'call-approve',
    arguments: { layer: 'L4', title: '包管理器', content: '团队统一使用 pnpm 10 管理工作区。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => {
    nextCalled += 1
    return { kind: 'allow' }
  })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(nextCalled, 1)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].provider, 'spawn')
  assert.equal(fake.calls[0].label, '记忆写入审计')
  assert.equal(fake.calls[0].delivery, 'parent')
  assert.equal(fake.calls[0].request.toolFilter.allow.length, 0)
  const stats = engine.auditStats()
  assert.equal(stats.approved, 1)
  assert.equal(stats.tokens.total, 95)
  assert.equal(engine.auditRuns({ status: 'approved' })[0].sourceQuote.includes('pnpm 10'), true)
})

await test('真实 activation 的 token 可从 sessionPersistence 回退读取', async () => {
  const fake = persistentSubagents(
    { verdict: 'approve', confidence: 0.9, reason: '来源明确' },
    { usage: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 1 } },
  )
  const hook = createAuditHook({ engine, getSubagents: () => fake.service, log })
  const before = engine.auditStats().tokens.total
  const decision = await hook.gate({
    name: 'memory_write',
    callId: 'call-persist-usage',
    arguments: { layer: 'L4', title: '持久化 token', content: '这条记忆用于验证子会话 token 回退。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  assert.equal(engine.auditStats().tokens.total - before, 951)
})

await test('token 读取失败不影响审计放行', async () => {
  const fake = persistentSubagents(
    { verdict: 'approve', confidence: 0.9, reason: '来源明确' },
    { openError: new Error('session store offline') },
  )
  const hook = createAuditHook({ engine, getSubagents: () => fake.service, log })
  const failedBefore = engine.auditStats().failed
  const decision = await hook.gate({
    name: 'memory_write',
    callId: 'call-persist-error',
    arguments: { layer: 'L4', title: 'token 读取失败', content: '读取失败时仍应按审计结论放行。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  assert.equal(engine.auditStats().failed, failedBefore)
  const run = engine.auditRuns({ limit: 20 }).find((item) => item.callId === 'call-persist-error')
  assert.equal(run.status, 'approved')
  assert.equal(run.usage.totalTokens, 0)
})

await test('高置信度拒绝会阻止写入并记录原因', async () => {
  const fake = fakeSubagents({ verdict: 'reject', confidence: 0.92, reason: '用户没有表达这个偏好' })
  const hook = createAuditHook({ engine, getSubagents: () => fake.service, log })
  let nextCalled = 0
  const decision = await hook.gate({
    name: 'memory_write',
    callId: 'call-reject',
    arguments: { layer: 'L4', title: '错误偏好', content: '用户喜欢使用 npm 而不是 pnpm。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => {
    nextCalled += 1
    return { kind: 'allow' }
  })
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('没有表达'))
  assert.equal(nextCalled, 0)
  assert.equal(engine.auditStats().rejected, 1)
})

await test('关闭 enforce 时拒绝只记录不阻断', async () => {
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), {
    hook: { enabled: true, enforce: false, minConfidence: 0.7 },
  }))
  const fake = fakeSubagents({ verdict: 'reject', confidence: 0.92, reason: '仅提示' })
  const hook = createAuditHook({ engine, getSubagents: () => fake.service, log })
  let nextCalled = 0
  const decision = await hook.gate({
    name: 'memory_write',
    callId: 'call-shadow',
    arguments: { layer: 'L4', title: '影子模式', content: '影子模式下这条记忆仍然会被写入。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => {
    nextCalled += 1
    return { kind: 'allow' }
  })
  assert.equal(decision.kind, 'allow')
  assert.equal(nextCalled, 1)
  assert.equal(engine.auditStats().rejected, 2)
})

await test('needs_user 候选拦截后经人工批准才写入', async () => {
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), {
    hook: { enabled: true, enforce: true, minConfidence: 0.7 },
  }))
  const fake = fakeSubagents({ verdict: 'needs_user', confidence: 0.4, reason: '证据不足' })
  const hook = createAuditHook({ engine, getSubagents: () => fake.service, log })
  const beforePending = engine.auditStats().pending
  let nextCalled = 0
  const decision = await hook.gate({
    name: 'memory_write',
    callId: 'call-needs-user',
    arguments: { layer: 'L4', title: '待确认候选', content: '这条内容需要人工确认后才能写入。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => {
    nextCalled += 1
    return { kind: 'allow' }
  })
  assert.equal(decision.kind, 'deny')
  assert.equal(nextCalled, 0)
  assert.equal(engine.auditStats().pending, beforePending + 1)

  const before = engine.stats().total
  const candidate = engine.auditRuns({ status: 'needs_user' })[0]
  const approved = await engine.decideAuditRun(candidate.id, 'approve', '人工确认', 'tester')
  assert.equal(approved.status, 'approved')
  assert.equal(typeof approved.appliedItemId, 'string')
  assert.equal(engine.stats().total, before + 1)
  const item = await engine.getItem(approved.appliedItemId)
  assert.equal(item.title, '待确认候选')

  // 重复批准不应重复写入。
  await engine.decideAuditRun(candidate.id, 'approve', '再次批准', 'tester')
  assert.equal(engine.stats().total, before + 1)
})

await test('审计服务缺失时失败放行', async () => {
  await engine.replaceSettings(applySettingsPatch(engine.getSettings(), {
    hook: { enabled: true, enforce: true },
  }))
  const hook = createAuditHook({ engine, getSubagents: () => undefined, log })
  let nextCalled = 0
  const decision = await hook.gate({
    name: 'memory_write',
    callId: 'call-missing',
    arguments: { layer: 'L4', title: '缺失服务', content: '没有 subagents 服务时仍然要允许写入。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => {
    nextCalled += 1
    return { kind: 'allow' }
  })
  assert.equal(decision.kind, 'allow')
  assert.equal(nextCalled, 1)
  assert.equal(engine.auditStats().failed, 1)
})

await test('审计起点持久化失败时 fail-open', async () => {
  const brokenEngine = {
    getSettings: () => ({ hook: { enabled: true, enforce: true } }),
    recordAuditRun: async () => { throw new Error('disk full') },
  }
  const hook = createAuditHook({ engine: brokenEngine, getSubagents: () => undefined, log })
  let nextCalled = 0
  const decision = await hook.gate({
    name: 'memory_write',
    arguments: { layer: 'L4', title: '起点失败', content: '审计账本写不进去时仍应允许写入。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => {
    nextCalled += 1
    return { kind: 'allow' }
  })
  assert.equal(decision.kind, 'allow')
  assert.equal(nextCalled, 1)
})

await test('startActivation 卡住时按超时放行', async () => {
  const runs = []
  const fakeEngine = {
    getSettings: () => ({ hook: { enabled: true, enforce: true, timeoutSeconds: 0.01 } }),
    recordAuditRun: async (input) => {
      const run = { ...input, id: input.id, usage: {} }
      runs.push(run)
      return run
    },
    finishAuditRun: async (id, patch) => {
      const run = runs.find((candidate) => candidate.id === id)
      Object.assign(run, patch)
      return run
    },
  }
  const hook = createAuditHook({
    engine: fakeEngine,
    minimumTimeoutMs: 20,
    getSubagents: () => ({ startActivation: () => new Promise(() => {}) }),
    log,
  })
  const started = Date.now()
  const decision = await hook.gate({
    name: 'memory_write',
    arguments: { layer: 'L4', title: '卡住的仲裁', content: '仲裁子智能体卡住时不能拖死工具调用。', ttlDays: 30 },
    agent: fakeAgent(),
  }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  assert.ok(Date.now() - started < 1000, '超时应迅速返回')
  assert.equal(runs[0].status, 'failed')
})

console.log(`\n${passed} 项通过，数据目录：${store.dir}`)
