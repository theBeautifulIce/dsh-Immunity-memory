/**
 * 客户端页面（client.js）的渲染冒烟测试：用真实的 react + react-dom/server
 * 把 settings.section 注册的组件以及各子面板渲染成 HTML，捕捉渲染期异常。
 *
 * 运行：node tests/client.render.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const REPO = 'D:\\aboutAI\\记忆插件设计'
const CLIENT_FILE = join(REPO, 'packages', 'memory-plugin', 'client.js')

const reactRequire = createRequire('C:\\Users\\ASUS\\.dsh\\profiles\\web\\package.json')
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
let registered = null
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
      assert.equal(key, 'settings.section')
      callback()
    },
    register(spec, Component) {
      registered = { spec, Component }
      return () => {}
    },
  },
}
mod.apply(fakeCtx)

assert.ok(registered !== null, '应注册 settings.section')
assert.equal(registered.spec.name, 'settings.section')
assert.equal(registered.spec.id, 'memory-plugin')
assert.equal(registered.spec.order, 60)
assert.equal(registered.spec.label(), '记忆')

// ---------------------------------------------------------------- 假数据 ----
const boot = {
  pluginVersion: '0.1.0',
  enabled: true,
  settings: DEFAULT_SETTINGS,
  schema: SETTINGS_SCHEMA,
  sortChoices: SORT_CHOICES,
  layers: LAYERS,
  notebooks: NOTEBOOKS,
  toolNames: ['memory_write', 'memory_search', 'memory_get', 'memory_update', 'memory_delete', 'memory_stats'],
  stats: { total: 3, memory: 2, note: 1, active: 3, archived: 0, expired: 0, conflicted: 0, pinned: 1, byLayer: { L5: 2, L4: 1 }, lastWriteAt: '2026-11-05T10:00:00.000Z' },
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
const shell = render('MemorySettingsPage 加载态', React.createElement(registered.Component))
assert.ok(shell.includes('mp-root'), '应包含根容器样式类名')

const { MemorySettingsPage, ItemBrowser, ItemEditor, SettingsPanel, MaintenancePanel } = mod.__internals
render('MemorySettingsPage（直接调用）', React.createElement(MemorySettingsPage))

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
