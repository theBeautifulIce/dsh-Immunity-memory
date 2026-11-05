/**
 * Host 侧 HTTP 接口：设置页（Client）通过 `fetch('/memory-plugin/api', {method:'POST'})`
 * 调用这里，与模型工具共用同一套引擎方法 —— 用户界面和 Agent 永远看到同一份数据。
 *
 * 为什么用 HTTP 而不是 Client↔Host 的私有 RPC：
 *   DSH 的客户端模块只能拿到 `fetch`，市场里所有带界面的插件（terse-mode、mcp-connector、
 *   dshmarket）都走这条路；桌面壳对 GET 的转发不可靠，所以读操作也用 POST。
 */
import {
  DEFAULT_SETTINGS,
  LAYERS,
  NOTEBOOKS,
  SETTINGS_SCHEMA,
  SORT_CHOICES,
  applySettingsPatch,
  clone,
  normalizeSettings,
} from './settings.js'
import { message } from './store.js'

/**
 * 接口前缀。
 *
 * 末段带版本号是刻意的：路由一旦注册就只能在卸载时由注册方释放，而历史版本
 * 可能留下一条同路径的旧路由（插件重装时旧行未必被干净卸载）。路径带版本
 * 号后新代码总能注册到一条干净路由，不会被上一代的路由挡住。
 */
export const API_PATH = '/dsh-memory-plugin/api/v2'
/** 兼容早期文档与外部脚本的旧前缀；注册时尽力而为，被占用就跳过。 */
export const LEGACY_API_PATH = '/memory-plugin/api'
export const API_METHODS = [
  'bootstrap',
  'status',
  'items.list',
  'items.search',
  'items.get',
  'items.create',
  'items.update',
  'items.delete',
  'items.bulk',
  'settings.get',
  'settings.save',
  'settings.reset',
  'maintenance.run',
  'prompt.preview',
  'audit.list',
  'data.export',
  'data.import',
]

/**
 * 建立方法表。`engineOf()` 每次调用都返回"当前这一代"的引擎实例：
 * 路由可能比插件行活得更久（卸载不会自动撤销前缀路由），所以 handler 不能在
 * 注册时就把引擎锁死，否则重装后设置页读到的还是上一代的旧数据。
 */
function createMethods(engineOf) {
  const engine = () => engineOf()
  const methods = {
    bootstrap() {
      const status = engine().status()
      const settings = engine().getSettings()
      return {
        ...status,
        settings,
        schema: SETTINGS_SCHEMA,
        defaults: DEFAULT_SETTINGS,
        sortChoices: SORT_CHOICES,
        audit: engine().auditList(12),
      }
    },
    status() {
      return engine().status()
    },
    'items.list'(params) {
      return engine().listItems(params ?? {})
    },
    'items.search'(params) {
      return engine().searchItems(params ?? {})
    },
    'items.get'(params) {
      const item = engine().getItem(String(params?.id ?? ''))
      if (item === undefined) throw notFound(params?.id)
      return { item }
    },
    'items.create'(params) {
      const item = engine().createItem(params ?? {}, 'user')
      return { item }
    },
    'items.update'(params) {
      const id = String(params?.id ?? '')
      const patch = params?.patch ?? params ?? {}
      const item = engine().updateItem(id, patch, 'user')
      return { item }
    },
    'items.delete'(params) {
      return engine().deleteItems(params?.ids ?? params?.id ?? [], 'user')
    },
    'items.bulk'(params) {
      return engine().bulkAction(params?.ids ?? [], String(params?.action ?? ''), 'user')
    },
    'settings.get'() {
      return { settings: engine().getSettings(), schema: SETTINGS_SCHEMA }
    },
    'settings.save'(params) {
      const patch = params?.patch ?? {}
      const next = applySettingsPatch(engine().getSettings(), patch)
      const settings = engine().replaceSettings(next)
      return { settings, stats: engine().stats() }
    },
    'settings.reset'(params) {
      const settings = engine().replaceSettings(normalizeSettings(params?.keepStorage === true
        ? { storage: engine().getSettings().storage }
        : {}))
      return { settings }
    },
    'maintenance.run'(params) {
      return engine().runMaintenance(params ?? {})
    },
    'prompt.preview'() {
      return { text: engine().promptDigest(), enabled: engine().getSettings().prompt.inject }
    },
    'audit.list'(params) {
      return { audit: engine().auditList(params?.limit ?? 50) }
    },
    'data.export'() {
      return { export: engine().exportData() }
    },
    'data.import'(params) {
      const result = engine().importData(params?.data ?? params ?? {}, params?.mode === 'replace' ? 'replace' : 'merge')
      return { ...result, stats: engine().stats() }
    },
  }
  return methods
}

function notFound(id) {
  const error = new Error(`找不到条目 ${id}`)
  error.code = 'NOT_FOUND'
  return error
}

/**
 * 把路由挂到 Host 的 webServer 上，返回释放器。
 *
 * `options.path` 允许测试或兼容路由挂到别的前缀上；缺省用 `API_PATH`。
 */
export function mountApi(webServer, engineAccessor, log, options = {}) {
  // 既接受引擎实例（测试里直接传），也接受取值函数（运行时用来跨代取到最新引擎）。
  const engineOf = typeof engineAccessor === 'function' ? engineAccessor : () => engineAccessor
  const methods = createMethods(engineOf)
  const basePath = typeof options.path === 'string' && options.path !== '' ? options.path : API_PATH
  return webServer.register({
    kind: 'prefix',
    path: basePath,
    handler: (req, res) => {
      handleRequest(req, res, methods, log, basePath).catch((error) => {
        log('warn', `接口异常：${message(error)}`)
        sendJson(res, 500, { ok: false, error: { code: 'internal', message: message(error) } })
      })
    },
  })
}

async function handleRequest(req, res, methods, log, basePath = API_PATH) {
  if (!isTrustedRequest(req)) {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求来源不受信任' } })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const tail = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length).replace(/^\/+/, '') : ''
  let body = {}
  if (req.method === 'POST') {
    body = await readJsonBody(req)
  } else if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  const method = typeof body.method === 'string' && body.method !== '' ? body.method : tail
  if (method === '') {
    sendJson(res, 200, { ok: true, value: { ok: true, methods: API_METHODS } })
    return
  }
  const handler = methods[method]
  if (handler === undefined) {
    sendJson(res, 404, { ok: false, error: { code: 'unknown_method', message: `未知接口 ${method}` } })
    return
  }
  try {
    const value = await handler(body.params ?? body)
    sendJson(res, 200, { ok: true, value })
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'bad_request'
    const status = code === 'NOT_FOUND' ? 404 : code === 'DISABLED' ? 409 : 400
    if (status >= 500) log('warn', `接口 ${method} 失败：${message(error)}`)
    sendJson(res, status, { ok: false, error: { code, message: message(error) } })
  }
}

// ------------------------------------------------------------------ 兼容层 --

/** 只看回环或已声明的可信来源，挡掉跨站请求。 */
export function isTrustedRequest(req) {
  const hostHeader = req.headers?.host
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  let host
  try {
    host = new URL(`http://${hostHeader}`)
  } catch {
    return false
  }
  const hostname = host.hostname.replace(/^\[|\]$/g, '')
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  const trusted = getTrustedHosts()
  const allowed = loopback || trusted.some((entry) => entry === hostname || entry === hostHeader || entry === host.host)
  if (!allowed) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const parsed = new URL(origin)
      if (parsed.host !== hostHeader) return false
    } catch {
      return false
    }
  }
  return true
}

let trustedHostsCache = []
export function setTrustedHosts(hosts) {
  trustedHostsCache = Array.isArray(hosts) ? hosts.filter((entry) => typeof entry === 'string') : []
}

function getTrustedHosts() {
  return trustedHostsCache
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('请求体超过 2MB')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

export { LAYERS, NOTEBOOKS, clone }

