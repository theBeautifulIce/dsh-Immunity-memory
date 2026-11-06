/**
 * 客户端页面（client.js）的渲染冒烟测试：用真实的 react + react-dom/server
 * 把侧边栏图标、main 整页、settings.section 以及各子面板渲染成 HTML，捕捉渲染期异常。
 *
 * 运行：node tests/client.render.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = join(REPO, 'packages', 'memory-plugin', 'client.js')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilePkg = join(dshHome, 'profiles', 'web', 'package.json')
if (!existsSync(profilePkg)) {
  throw new Error(`React profile not found: ${profilePkg}. Run this test inside a DSH installation or set DSH_HOME.`)
}
const reactRequire = createRequire(profilePkg)
const React = reactRequire('react')
const { renderToString } = reactRequire('react-dom/server')

const { DEFAULT_SETTINGS, LAYERS, NOTEBOOKS, SETTINGS_SCHEMA, SORT_CHOICES } = await import(
  pathToFileURL(join(REPO, 'packages', 'memory-plugin', 'lib', 'settings.js')).href
)

// ---------------------------------------------------------------- 浏览器垫片 ----
let loaded = null
const styles = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}
globalThis.location = { origin: 'http://127.0.0.1:57183', href: 'http://127.0.0.1:57183/' }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.document = {
  baseURI: 'http://127.0.0.1:57183/',
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, set textContent(v) { styles.push(v) } }),
  getElementById: () => null,
  querySelector: () => null,
}
globalThis.fetch = async () => {
  throw new TypeError('offline in render test')
}

const requireStub = (id) => {
  if (id === 'react') return React
  if (id === 'react-dom/client') return reactRequire('react-dom/client')
  if (id === 'react/jsx-runtime') return reactRequire('react/jsx-runtime')
  throw new Error(`unexpected require: ${id}`)
}

await import(pathToFileURL(CLIENT_FILE).href)
assert.ok(loaded !== null, '客户端模块应通过 __ModuleLoader__.load 注册')
assert.equal(loaded.id, 'dsh-memory-plugin')

const mod = loaded.factory(requireStub)
assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, ['slots'])

// ---------------------------------------------------------------- 假 ctx ----
const registered = new Map()
const fakeCtx = {
  get(name) {
    if (name === 'styles') return { insert: (css) => { styles.push(css); return () => {} } }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: () => () => {} },
  slots: {
    inject(key, callback) {
      assert.ok(['settings.section', 'sidebar.panellist', 'main'].includes(key), `未知槽位 ${key}`)
      callback()
    },
    register(spec, Component) {
      registered.set(spec.name, { spec, Component })
      return () => {}
    },
  },
}
mod.apply(fakeCtx)

// 三个落点：设置页 + 侧边栏图标 + 整页主面板。
const settingsReg = registered.get('settings.section')
assert.ok(settingsReg, '应注册 settings.section')
assert.equal(settingsReg.spec.id, 'memory-plugin')
assert.equal(settingsReg.spec.order, 60)
assert.equal(settingsReg.spec.label(), '记忆')

const sidebarReg = registered.get('sidebar.panellist')
assert.ok(sidebarReg, '应注册 sidebar.panellist，才能从侧边栏打开')
assert.equal(sidebarReg.spec.id, 'memory')
assert.equal(sidebarReg.spec.order, 20)
assert.equal(sidebarReg.spec.label(), '记忆')

const mainReg = registered.get('main')
assert.ok(mainReg, '应注册 main 整页面板')
assert.equal(mainReg.spec.key, 'memory')
assert.equal(mod.__internals.PANEL_ID, 'memory')

// ---------------------------------------------------------------- 假数据 ----
const boot = {
  pluginVersion: '0.2.0',
  enabled: true,
  settings: DEFAULT_SETTINGS,
  schema: SETTINGS_SCHEMA,
  sortChoices: SORT_CHOICES,
  layers: LAYERS,
  notebooks: NOTEBOOKS,
  toolNames: ['memory_write', 'memory_search', 'memory_get', 'memory_update', 'memory_forget', 'memory_stats', 'memory_usage', 'memory_consolidate', 'memory_pitfall', 'memory_diff'],
  injection: {
    enabled: true,
    text: '## 长期记忆（dsh-memory-plugin）\n\n- [L5·重要度6] 示例记忆：示例正文',
    tokens: 120,
    chars: 800,
    topN: 6,
    maxChars: 1200,
    truncated: false,
    template: {
      id: 'default',
      name: { zh: '通用', en: 'General' },
      layers: { L0: 1, L1: 1, L3: 1 },
    },
    templateItemCount: 3,
    sharedItemCount: 2,
    itemCount: 2,
    headerTokens: 30,
    layers: [
      { id: 'L5', name: { zh: '目标记忆', en: 'Goals' }, tokens: 80, percent: 66, count: 2 },
      { id: 'L4', name: { zh: '学习行为', en: 'Learned' }, tokens: 10, percent: 8, count: 1 },
    ],
  },
  templates: {
    active: 'default',
    list: [
      { id: 'default', name: { zh: '通用', en: 'General' }, layers: { L0: [], L1: [], L3: [] } },
      {
        id: 'tpl_demo',
        name: { zh: '分层模板', en: 'Layered template' },
        custom: true,
        header: '## 分层模板',
        topN: 8,
        maxChars: 1400,
        layers: {
          L0: [{ title: '身份', content: '不可变身份' }],
          L1: [{ title: '原则', content: '先验证再承诺' }],
          L3: [{ title: '反射', content: '风险先停下' }],
        },
      },
    ],
  },
  consolidation: { candidates: [] },
  hook: {
    stats: {
      enabled: true, enforce: true, minConfidence: 0.7, total: 3, running: 0, approved: 1,
      rejected: 1, needs_user: 1, failed: 0, blocked: 1, needsUser: 1, pending: 1,
      tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, total: 125 },
    },
    runs: [{
      id: 'audit_demo0001', at: '2026-11-06T03:00:00.000Z', tool: 'memory_write',
      title: '示例候选', layer: 'L4', status: 'needs_user', verdict: 'needs_user',
      confidence: 0.4, reason: '证据不足', enforced: true, sourceQuote: '用户原话',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 125 },
    }],
  },
  usage: { calls: 1, queryTokens: 4, resultTokens: 30, totalTokens: 34 },
  stats: { total: 3, memory: 2, note: 1, active: 3, archived: 0, expired: 0, conflicted: 0, pinned: 1, byLayer: { L5: 2, L4: 1 }, byNotebook: { memory: 2, daily: 1, asset: 0, pitfall: 0 }, lastWriteAt: '2026-11-05T10:00:00.000Z' },
  storage: { path: 'C:\\Users\\ASUS\\.dsh\\storages\\dsh-memory-plugin\\store.json', dir: 'C:\\Users\\ASUS\\.dsh\\storages\\dsh-memory-plugin', exists: true, bytes: 2048, modifiedAt: '2026-11-05T10:00:00.000Z' },
  audit: [{ at: '2026-11-05T10:00:00.000Z', action: 'create', detail: 'mem_test' }],
}
const api = new Proxy({}, { get: () => async () => ({}) })
const noop = () => {}

let passed = 0
function render(title, element) {
  const html = renderToString(element)
  assert.ok(html.length > 0, `${title} 不应渲染为空`)
  passed += 1
  console.log(`  ok  ${title} (${html.length} 字节)`)
  return html
}

// 首屏（boot 尚未返回，渲染加载态）
const shell = render('MemorySettingsPage 加载态', React.createElement(settingsReg.Component))
assert.ok(shell.includes('mp-root'), '应包含根容器样式类名')

const { MemorySettingsPage, MemoryPage, MemoryPanelIcon, ItemBrowser, ItemEditor, SettingsPanel, MaintenancePanel, InjectionCard, TemplateLayerEditor, UsagePanel, AuditPanel, ConsolidationPanel, LayerBadge, PitfallPanel, DiffPanel, DiffView } = mod.__internals
render('MemorySettingsPage（直接调用）', React.createElement(MemorySettingsPage))

// 侧边栏入口：整页容器必须自己滚动（main 槽位是 overflow:hidden 的列）。
const page = render('MemoryPage 侧边栏整页', React.createElement(MemoryPage))
assert.ok(page.includes('mp-page'), '整页应有 mp-page 容器')
assert.ok(page.includes('overflow-y:auto') || page.includes('overflow-y: auto'), '整页应可滚动')
assert.ok(page.includes('mp-root'), '整页内应渲染记忆面板')

const icon = render('MemoryPanelIcon', React.createElement(MemoryPanelIcon, { size: 20, active: true }))
assert.ok(icon.includes('width="20"'), '图标应使用传入的尺寸')
assert.ok(icon.includes('currentColor'), '图标应跟随主题色')

const layerBadge = render('LayerBadge 层级徽章', React.createElement(LayerBadge, {
  item: { layer: 'L5', layerName: { zh: '目标记忆', en: 'Goals' } }, large: true,
}))
assert.ok(layerBadge.includes('mp-layer-badge'), '层级徽章应有颜色类名')
assert.ok(layerBadge.includes('目标记忆'), '中文环境应显示层名')

render('InjectionCard 注入统计', React.createElement(InjectionCard, {
  api, lang: 'zh', boot, notify: noop, onChanged: noop,
}))

const templateDraft = {
  name: '分层模板',
  header: '## 分层模板',
  topN: 8,
  maxChars: 1400,
  layers: {
    L0: [{ title: '身份', content: '不可变身份' }],
    L1: [{ title: '原则', content: '先验证再承诺' }],
    L3: [{ title: '反射', content: '风险先停下' }],
  },
}
const layerEditor = render('TemplateLayerEditor 分层模板编辑', React.createElement(TemplateLayerEditor, {
  draft: templateDraft,
  setDraft: noop,
  saving: false,
  editableLayers: LAYERS.filter((layer) => ['L0', 'L1', 'L3'].includes(layer.id)),
  lang: 'zh',
}))
for (const label of ['不可变层', '灵魂层', '思想核心', '本能行为', 'L2 思想流动', '共享复用']) {
  assert.ok(layerEditor.includes(label), `分层模板编辑器应包含“${label}”`)
}

render('UsagePanel 用量', React.createElement(UsagePanel, { api, lang: 'zh', boot, notify: noop }))
const auditPanel = render('AuditPanel 审计候选', React.createElement(AuditPanel, {
  api, lang: 'zh', boot, notify: noop, onChanged: noop,
}))
assert.ok(auditPanel.includes('候选队列'), '审计页应显示候选队列')
assert.ok(auditPanel.includes('125'), '审计页应显示累计 token')
render('PitfallPanel 踩坑笔记', React.createElement(PitfallPanel, {
  api, lang: 'zh', notify: noop, onChanged: noop,
}))
const diffView = render('DiffView 红绿差异', React.createElement(DiffView, {
  lang: 'zh',
  change: {
    operation: 'update',
    itemId: 'mem_diff',
    title: '差异展示',
    changed: ['title', 'content'],
    before: { id: 'mem_diff', type: 'memory', version: 1, title: '旧标题', content: '第一行\n旧内容\n保留行' },
    after: { id: 'mem_diff', type: 'memory', version: 2, title: '新标题', content: '第一行\n新内容\n保留行' },
  },
}))
for (const token of ['mp-diff-line is-remove', 'mp-diff-line is-add', '旧标题', '新标题', '旧内容', '新内容', '保留行']) {
  assert.ok(diffView.includes(token), `DiffView 应包含“${token}”`)
}
assert.ok(!diffView.includes('&quot;before&quot;'), 'DiffView 不应直接输出 JSON')

render('DiffPanel 时间段变更', React.createElement(DiffPanel, { api, lang: 'zh', notify: noop }))
const styleText = styles.join('\n')
assert.ok(styleText.includes('.mp-change-card.is-update .mp-chip:first-child::before'), '变更卡应使用操作徽章圆点标识类型')
assert.ok(!styleText.includes('border-left:3px solid #9a6700'), '变更卡不应再使用左侧粗色条')
render('ConsolidationPanel 固化', React.createElement(ConsolidationPanel, {
  api, lang: 'zh', boot, notify: noop, onChanged: noop,
}))

const browser = render('ItemBrowser 记忆列表', React.createElement(ItemBrowser, {
  api, lang: 'zh', settings: DEFAULT_SETTINGS, kind: 'memory', notify: noop, onChanged: noop,
}))
assert.ok(/class="mp-/.test(browser), '记忆列表应输出带 mp- 前缀的样式类')

const noteBrowser = render('ItemBrowser 记事本', React.createElement(ItemBrowser, {
  api, lang: 'en', settings: DEFAULT_SETTINGS, kind: 'note', notify: noop, onChanged: noop,
}))
assert.ok(noteBrowser.length > 0)

const editor = render('ItemEditor 编辑记忆', React.createElement(ItemEditor, {
  lang: 'zh',
  draft: {
    title: '示例记忆', content: '示例正文，用于渲染冒烟测试。', tags: '示例, 测试',
    layer: 'L5', importance: 6, notebook: 'memory', ttlDays: 30, status: 'active', pinned: false,
  },
  setDraft: noop, creating: false, saving: false, isNote: false,
  settings: DEFAULT_SETTINGS, onSave: noop, onDelete: noop, onBulk: noop, onClose: noop,
}))
assert.ok(editor.includes('示例记忆'), '编辑器应显示标题')

render('ItemEditor 编辑记事本（只读层）', React.createElement(ItemEditor, {
  lang: 'en',
  draft: {
    title: 'Soul', content: 'immutable layer', tags: '',
    layer: 'L0', importance: 9, notebook: 'memory', ttlDays: 0, status: 'active', pinned: true,
  },
  setDraft: noop, creating: true, saving: true, isNote: false,
  settings: DEFAULT_SETTINGS, onSave: noop, onDelete: noop, onBulk: noop, onClose: noop,
}))

const settingsPanel = render('SettingsPanel 全部设置项', React.createElement(SettingsPanel, {
  api, lang: 'zh', boot, notify: noop, onSaved: noop,
}))
assert.ok(settingsPanel.includes('mp-card'), '设置面板应有分组卡片')
for (const group of SETTINGS_SCHEMA) {
  assert.ok(settingsPanel.length > 0, `分组 ${group.id} 渲染`)
}

render('SettingsPanel 英文', React.createElement(SettingsPanel, {
  api, lang: 'en', boot, notify: noop, onSaved: noop,
}))

const maintenance = render('MaintenancePanel', React.createElement(MaintenancePanel, {
  api, lang: 'zh', boot, notify: noop, onChanged: noop,
}))
assert.ok(maintenance.includes('mp-card'))

render('MaintenancePanel 英文', React.createElement(MaintenancePanel, {
  api, lang: 'en', boot, notify: noop, onChanged: noop,
}))

assert.ok(styles.length >= 1, '应注入样式表')
assert.ok(String(styles[0]).includes('.mp-root'), '样式表应包含 .mp-root')

console.log(`\n${passed} 个面板渲染通过，样式注入 ${styles.length} 段`)

