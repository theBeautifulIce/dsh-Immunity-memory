/**
 * dsh-memory-plugin —— 跨会话的长期记忆。
 *
 * 结构：
 *   index.js        宿主入口（本文件）：装载引擎、注册工具、注册 HTTP 接口、注入提示词
 *   lib/settings.js 设置模型（默认值 + 表单描述 + 校验）
 *   lib/store.js    JSON 存储（原子写 + 备份轮转）
 *   lib/engine.js   八层记忆 / 记事本 / 检索 / 维护
 *   lib/api.js      设置页使用的 HTTP 接口
 *   lib/tools.js    模型可调用的工具
 *   client.js       客户端设置页（无构建步骤）
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { Config, normalizeSettings } from './lib/settings.js'
import { message } from './lib/store.js'
import { createStorage } from './lib/storage.js'
import { createEngine } from './lib/engine.js'
import { API_PATH, LEGACY_API_PATH, mountApi, setTrustedHosts } from './lib/api.js'
import { registerTools } from './lib/tools.js'

export const name = 'dsh-memory-plugin'
export const inject = ['tools', 'systemPrompt']
export { Config }

/** 宿主入口。 */
export function apply(ctx, config) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('memory-plugin') : ctx.logger
  const log = (level, text) => {
    try {
      const write = logger?.[level]
      if (typeof write === 'function') write.call(logger, text)
      else if (typeof console !== 'undefined' && typeof console[level] === 'function') console[level](`[memory-plugin] ${text}`)
    } catch {
      // 日志失败不影响主流程
    }
  }

  // store 的路径 / 备份份数依赖设置，而设置由引擎持有：先留一个引用位，避免构造顺序死锁。
  const ref = { engine: null }
  let store
  let storageKind = 'json'
  try {
    const created = createStorage(ctx, log, () => ref.engine?.getSettings?.() ?? normalizeSettings(config ?? {}))
    store = created.store
    storageKind = created.kind
  } catch (error) {
    log('error', `初始化存储失败：${message(error)}`)
    return
  }
  // 插件卸载时关掉 SQLite 连接（JSON 存储没有 close）。
  ctx.effect(() => () => {
    try {
      store.close?.()
    } catch {
      /* 已关闭 */
    }
  }, 'memory-plugin:storage')

  const initialSettings = normalizeSettings(config ?? {})
  const engine = createEngine({
    store,
    initialSettings,
    getSettings: () => initialSettings,
    log,
  })
  ref.engine = engine

  // 显式加载一次：SQLite 存储打开时要读设置，引擎的 getSettings 此时不能反过来加载状态
  // （否则递归）。这里一次性把状态读进来，之后 getSettings 直接返回存档里的设置。
  try {
    engine.reload()
  } catch (error) {
    log('warn', `读取记忆库失败，按空库继续：${message(error)}`)
  }

  // 桌面端的宿主日志不落在插件能读的地方；关键路径同时写一份到数据目录，
  // 出问题时可以直接看 <storageDir>/plugin.log。
  const debug = createDebugLog(store, log)
  debug('apply: start')
  debug(`runtime: node=${process.versions.node} electron=${process.versions.electron ?? '-'} sqlite=${sqliteProbe()} storage=${storageKind}`)

  ctx.effect(() => registerTools(ctx, engine, log), 'memory-plugin:tools')
  log('info', `记忆库已就绪（${storageKind}）：${store.path}`)

  // 提示词注入：让模型知道有长期记忆可用，并给出最相关的一小段摘要。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory-plugin',
    order: 500,
    interpolate: false,
    text: () => {
      try {
        return engine.promptDigest()
      } catch (error) {
        log('warn', `生成记忆摘要失败：${message(error)}`)
        return ''
      }
    },
  }), 'memory-plugin:prompt')

  // 定时维护：过期清理 / 归档 / 去重 / 反思提升。
  ctx.effect(() => {
    const current = engine.getSettings()
    if (!current.maintenance.autoRun) return () => {}
    const hours = Math.max(1, current.maintenance.intervalHours)
    const timer = setInterval(() => {
      try {
        const report = engine.runMaintenance({ tasks: ['cleanup', 'archive', 'dedupe', 'reflect', 'compact'] })
        const changed = report.tasks.reduce((sum, task) => sum + (task.changed ?? 0), 0)
        if (changed > 0) log('info', `定时维护完成：${report.tasks.map((task) => task.note).join('；')}`)
        // 用户可能在设置页改了间隔或关掉了自动维护。
        if (!engine.getSettings().maintenance.autoRun) clearInterval(timer)
      } catch (error) {
        log('warn', `定时维护失败：${message(error)}`)
      }
    }, hours * 3600 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'memory-plugin:maintenance')

  attachApi(ctx, engine, debug)
}



/**
 * 把 HTTP 接口挂到 webServer 上。
 *
 * 三个坑：
 *   1. webServer 可能比本插件晚装载 → 用 `ctx.inject(['webServer'], ...)` 等它出现；
 *   2. 路由的生命周期不好保证（重装 / 热重载时旧路由可能还活着）→ 在 webServer 上放一个
 *      holder，handler 每次都从 holder 取"当前这一代"的引擎，旧路由也不会读到旧数据；
 *   3. 宿主日志不落盘 → 关键步骤同时写 <storageDir>/plugin.log，出问题能直接看。
 */
const API_HOLDER_KEY = '__dshMemoryPluginApi'

function attachApi(ctx, engine, debug) {
  const attach = (via) => {
    debug(`attach(${via}): start`)
    const webServer = ctx.get('webServer')
    if (webServer === undefined || webServer === null) {
      debug('attach: 当前 profile 没有 webServer，设置页接口不可用')
      return
    }
    debug(`attach: webServer ok, register=${typeof webServer.register}`)
    try {
      const runtime = ctx.get('webRuntime') ?? ctx.get('webApp')
      setTrustedHosts(runtime?.trustedHosts ?? [])
    } catch {
      // 拿不到可信域时退回回环判断
    }

    let holder = webServer[API_HOLDER_KEY]
    if (holder === undefined || holder === null) {
      holder = { engine: null, dispose: null, path: null, alive: false }
      try {
        webServer[API_HOLDER_KEY] = holder
        debug('attach: holder created')
      } catch (error) {
        // 有些服务对象冻结/代理，写不进去就退回本代自用（路由仍然能工作）
        holder = { engine: null, dispose: null, path: null, alive: false }
        debug(`attach: holder 写入失败，改用局部 holder：${message(error)}`)
      }
    }
    holder.engine = engine

    // 只有"路径相同且路由还活着"才算可复用。holder.dispose 非空并不能证明路由还在：
    // 激活失败的 fiber 被释放时路由会消失，但 holder 上的闭包对象还留着。
    if (holder.alive === true && holder.path === API_PATH) {
      debug(`attach: 复用已有路由 ${API_PATH}`)
      return
    }
    if (holder.dispose !== null) {
      try {
        holder.dispose()
      } catch {
        // 旧路由的释放失败不影响重新注册
      }
      holder.dispose = null
      holder.path = null
      holder.alive = false
      debug('attach: 释放了上一代的路由')
    }

    const disposers = []
    const apiLog = (level, text) => debug(`api ${level}: ${text}`)
    try {
      const routeEffect = ctx.effect(() => {
        const routeDispose = mountApi(webServer, () => holder.engine, apiLog)
        holder.alive = true
        debug(`attach: 路由已激活 ${API_PATH}`)
        return () => {
          holder.alive = false
          try {
            routeDispose?.()
          } catch {
            // 已经释放
          }
        }
      }, 'memory-plugin:api')
      disposers.push(routeEffect)
      holder.dispose = () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 已经随 fiber 释放
          }
        }
        holder.dispose = null
        holder.path = null
        holder.alive = false
      }
      holder.path = API_PATH
      debug(`attach: 注册成功 ${API_PATH}`)
    } catch (error) {
      // 路径可能被更早的一代占着：那条路由同样通过 holder.engine 取当前引擎，
      // 所以只要它还在服务，数据就是新的。
      holder.alive = holder.path === API_PATH
      debug(`attach: 注册失败 ${API_PATH}：${message(error)}`)
      return
    }

    // 旧前缀：只为了让早期文档里的地址继续可用，被占用就静默跳过。
    try {
      disposers.push(ctx.effect(
        () => mountApi(webServer, () => holder.engine, apiLog, { path: LEGACY_API_PATH }),
        'memory-plugin:api-legacy',
      ))
      debug(`attach: 注册成功（兼容前缀） ${LEGACY_API_PATH}`)
    } catch (error) {
      debug(`attach: 兼容前缀跳过 ${LEGACY_API_PATH}：${message(error)}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], () => attach('inject'))
    } catch (error) {
      debug(`attach: ctx.inject 失败：${message(error)}`)
      attach('fallback')
    }
  } else {
    attach('direct')
  }
}

/** 把一行诊断写到 <storageDir>/plugin.log（截断到 64KB），同时走宿主 logger。 */
function createDebugLog(store, log) {
  let file
  try {
    file = join(store.dir, 'plugin.log')
  } catch {
    file = undefined
  }
  return (line) => {
    try {
      log('info', line)
    } catch {
      /* 忽略 */
    }
    if (file === undefined) return
    try {
      mkdirSync(store.dir, { recursive: true })
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`.slice(0, 4000))
    } catch {
      /* 诊断写不了就算了 */
    }
  }
}


/** 探测宿主进程是否自带 SQLite（Node 22.5+ 的 node:sqlite）。 */
function sqliteProbe() {
  try {
    const getBuiltin = process.getBuiltinModule
    if (typeof getBuiltin !== 'function') return 'no-getBuiltinModule'
    const mod = getBuiltin('node:sqlite')
    return typeof mod?.DatabaseSync === 'function' ? 'yes' : 'no-DatabaseSync'
  } catch (error) {
    return `no: ${error instanceof Error ? error.message : String(error)}`
  }
}

