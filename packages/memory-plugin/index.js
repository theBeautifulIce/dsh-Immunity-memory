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
import { createStore, message } from './lib/store.js'
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
  try {
    store = createStore(ctx, log, () => ref.engine?.getSettings?.() ?? normalizeSettings(config ?? {}))
  } catch (error) {
    log('error', `初始化存储失败：${message(error)}`)
    return
  }

  const initialSettings = normalizeSettings(config ?? {})
  const engine = createEngine({
    store,
    initialSettings,
    getSettings: () => initialSettings,
    log,
  })
  ref.engine = engine

  // 桌面端的宿主日志不落在插件能读的地方；关键路径同时写一份到数据目录，
  // 出问题时可以直接看 <storageDir>/plugin.log。
  const debug = createDebugLog(store, log)
  debug('apply: start')

  ctx.effect(() => registerTools(ctx, engine, log), 'memory-plugin:tools')
  log('info', `记忆库已就绪：${store.path}`)

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
      holder = { engine: null, dispose: null, path: null }
      try {
        webServer[API_HOLDER_KEY] = holder
        debug('attach: holder created')
      } catch (error) {
        // 有些服务对象冻结/代理，写不进去就退回本代自用（路由仍然能工作）
        holder = { engine: null, dispose: null, path: null }
        debug(`attach: holder 写入失败，改用局部 holder：${message(error)}`)
      }
    }
    holder.engine = engine

    // 只有"同一个接口路径"才算可复用：插件升级可能换了前缀，旧 holder 指向的是旧路径。
    if (holder.dispose !== null && holder.path === API_PATH) {
      debug(`attach: 复用已有路由 ${API_PATH}`)
      return
    }
    if (holder.dispose !== null && holder.path !== API_PATH) {
      try {
        holder.dispose()
      } catch {
        // 旧路径的释放失败不影响新路径注册
      }
      holder.dispose = null
      holder.path = null
      debug('attach: 释放了旧路径的路由')
    }

    const disposers = []
    const apiLog = (level, text) => debug(`api ${level}: ${text}`)
    try {
      disposers.push(ctx.effect(() => mountApi(webServer, () => holder.engine, apiLog), 'memory-plugin:api'))
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
      }
      holder.path = API_PATH
      debug(`attach: 注册成功 ${API_PATH}`)
    } catch (error) {
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

