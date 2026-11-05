import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createGoStore } from '../packages/memory-plugin/lib/go-store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const WORK = join(process.cwd(), '.tmp', `probe-sem-${Date.now()}`)
mkdirSync(WORK, { recursive: true })
const log = () => {}
const ctx = { get: () => (...parts) => join(WORK, ...parts) }
const store = createGoStore(ctx, log, () => ({ storage: { engine: 'go' } }))
await store.ready()
const ref = { engine: null }
const engine = await createEngine({ store, initialSettings: normalizeSettings({}), getSettings: () => ref.engine?.getSettings() ?? normalizeSettings({}), log })
ref.engine = engine
const items = Array.from({ length: 300 }, (_, index) => ({
  id: `p_${index}`, type: 'memory', layer: 'L5', notebook: null,
  title: `缓存 主题 ${index}`, content: `用 pnpm 构建 缓存 说明 第 ${index} 条`,
  tags: ['缓存'], importance: 5, status: 'active', pinned: false, ttlDays: null, expiresAt: null,
  source: { kind: 'import', sessionId: null, workspace: null },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastAccessAt: new Date().toISOString(),
  accessCount: 0, version: 1, conflicts: [],
}))
await engine.importData({ items }, 'merge')

async function bench(label) {
  const times = []
  for (let index = 0; index < 20; index += 1) {
    const started = process.hrtime.bigint()
    const result = await engine.searchItems({ query: `缓存 ${index % 7}`, limit: 20 })
    times.push(Number(process.hrtime.bigint() - started) / 1e6)
    if (index === 0) console.log(label, 'first result:', result.items.length, 'tookMs', result.tookMs, 'breakdown', result.breakdown)
  }
  console.log(label, 'avg', (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2), 'ms')
}

console.log('settings semantic =', engine.getSettings().retrieval.semantic)
await bench('semantic on ')
const current = engine.getSettings()
await engine.replaceSettings(normalizeSettings({ ...current, retrieval: { ...current.retrieval, semantic: false } }))
console.log('settings semantic =', engine.getSettings().retrieval.semantic)
await bench('semantic off')
await store.close()
rmSync(WORK, { recursive: true, force: true })
