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
import { createNativeCore } from './lib/native.js'
import { API_PATH, LEGACY_API_PATH, mountApi, setTrustedHosts } from './lib/api.js'
import { registerTools } from './lib/tools.js'
import { createAuditHook } from './lib/audit.js'
import { createFileLogger } from './lib/log-file.js'
import { detectAssistantSignals, detectUserSignals, messageText } from './lib/capture.js'

export const name = 'dsh-memory-plugin'
export const inject = ['tools', 'systemPrompt']
export { Config }

/** 宿主入口。 */
export async function apply(ctx, config) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('memory-plugin') : ctx.logger
  // 存储层选引擎（Go 探活失败等）发生在拿到 store 之前，此时 plugin.log 还没建立；
  // 把 warn/error 同时写进 boot.log，否则线上只看得到"最终用了 sqlite"，看不到为什么。
  const bootDir = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'storages', 'dsh-memory-plugin')
  const bootFile = join(bootDir, 'boot.log')
  // 结构化日志器要等 store 就绪才知道目录；在那之前 logFile 是 null。
  let logFile = null
  const log = (level, text, event = 'log') => {
    try {
      const write = logger?.[level]
      if (typeof write === 'function') write.call(logger, text)
      else if (typeof console !== 'undefined' && typeof console[level] === 'function') console[level](`[memory-plugin] ${text}`)
    } catch {
      // 日志失败不影响主流程
    }
    if (logFile !== null) logFile.write(level, event, { text })
    if (level === 'warn' || level === 'error') {
      try {
        mkdirSync(bootDir, { recursive: true })
        appendFileSync(bootFile, `${new Date().toISOString()} ${level} ${text}\n`)
      } catch {
        // 启动期日志失败不影响主流程
      }
    }
  }

  // store 的路径 / 备份份数依赖设置，而设置由引擎持有：先留一个引用位，避免构造顺序死锁。
  const ref = { engine: null }
  let store
  let storageKind = 'json'
  try {
    const created = await createStorage(ctx, log, () => ref.engine?.getSettings?.() ?? normalizeSettings(config ?? {}))
    store = created.store
    storageKind = created.kind
  } catch (error) {
    log('error', `初始化存储失败：${message(error)}`)
    return
  }
  // 结构化日志从这一天起跟着 store 走：<storageDir>/logs/memory-YYYY-MM-DD.jsonl，
  // 一行一个 JSON，写满 2MB 滚一份、最多留 8 份。写在 store 就绪之后，因为之前
  // 还没有确定的数据目录（那一段靠 boot.log）。
  logFile = createFileLogger({ dir: join(store.dir, 'logs') })

  // 插件卸载时关掉 SQLite 连接（JSON 存储没有 close）。
  ctx.effect(() => () => {
    try {
      store.close?.()
    } catch {
      /* 已关闭 */
    }
  }, 'memory-plugin:storage')

  const initialSettings = normalizeSettings(config ?? {})
  // 原生计算核心（Rust）：批量余弦 / 重要性 / 去重。关掉或不可用时引擎自动走 JS 兜底。
  const native = initialSettings.performance?.nativeCore === false
    ? null
    : createNativeCore({ log })
  ctx.effect(() => () => {
    try {
      native?.close()
    } catch {
      /* 已关闭 */
    }
  }, 'memory-plugin:native')
  if (native !== null) {
    const nativeStatus = await native.warmup()
    if (nativeStatus.available) {
      log('info', `原生核心已就绪（v${nativeStatus.version}，protocol ${nativeStatus.protocol}，pid ${nativeStatus.pid}）`)
    } else {
      log('warn', `原生核心不可用，改用 JS 兜底：${nativeStatus.lastError ?? '未知原因'}`)
    }
  }

  const engine = await createEngine({
    store,
    native,
    initialSettings,
    getSettings: () => initialSettings,
    log,
  })
  ref.engine = engine

  // 把写入生命周期 Hook 暴露为 Cordis 服务，其他插件可以：
  //   ctx.get('memoryWriteHooks').onBeforeWrite((event) => { ... })
  // 注册表只负责拦截/改写/放行，不会自动生成或更新记忆；自动更新需要注册方自己实现。
  ctx.effect(() => ctx.provide('memoryWriteHooks', engine.writeHooks), 'memory-plugin:write-hooks')

  // 显式加载一次：SQLite 存储打开时要读设置，引擎的 getSettings 此时不能反过来加载状态
  // （否则递归）。这里一次性把状态读进来，之后 getSettings 直接返回存档里的设置。
  try {
    await engine.reload()
  } catch (error) {
    log('warn', `读取记忆库失败，按空库继续：${message(error)}`)
  }

  // 桌面端的宿主日志不落在插件能读的地方；关键路径同时写一份到数据目录，
  // 出问题时可以直接看 <storageDir>/plugin.log；同一条还会写进 logs/ 的结构化 JSON 日志。
  const debug = createDebugLog(store, log)
  debug('apply: start')
  debug(`runtime: node=${process.versions.node} electron=${process.versions.electron ?? '-'} sqlite=${sqliteProbe()} storage=${storageKind}`)

  ctx.effect(() => registerTools(ctx, engine, log), 'memory-plugin:tools')

  // 记忆写入审计：只在设置开启时拦截 memory_write / memory_update，
  // 用一个没有工具权限的干净子智能体判断来源是否成立。任何失败都放行。
  // subagents 是 agent 作用域服务：优先从本次调用携带的 agent.ctx 取，
  // 不硬注入，这样宿主没有该服务时插件仍能加载，审计按失败放行。
  const auditHook = createAuditHook({
    engine,
    log,
    getSubagents: (call) => {
      try {
        return call?.agent?.ctx?.get?.('subagents')
      } catch {
        return undefined
      }
    },
  })
  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => auditHook.gate(exec, next)), 'memory-plugin:audit-hook')
  log('info', `记忆写入审计：${engine.getSettings().hook?.enabled === true ? '已开启' : '关闭'}`)

  log('info', `记忆库已就绪（${storageKind}）：${store.path}`)

  // 提示词注入：让模型知道有长期记忆可用，并给出最相关的一小段摘要。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory-plugin',
    order: 500,
    interpolate: false,
    text: () => {
      try {
        const digest = engine.promptDigest()
        const capture = engine.capturePrompt()
        return [digest, capture].filter((part) => part !== '').join('\n\n')
      } catch (error) {
        log('warn', `生成记忆摘要失败：${message(error)}`)
        return ''
      }
    },
  }), 'memory-plugin:prompt')

  // 当轮上下文：只给注入排序用（不落库、不进导出）。
  // 用户消息说「现在要什么」，工具报错说「现在撞上了什么坑」——后者让"昨天踩过的坑"
  // 在报错当轮就被拉回提示词前排，而不是靠模型自己想起来去搜。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const kind = event?.type
    if (kind !== 'user/message' && kind !== 'tool/result') return
    const origin = session?.header?.origin ?? session?.origin ?? session?.header?.kind
    if (origin === 'subagent' || origin === 'subagent-run') return
    const sessionId = typeof session?.id === 'string' ? session.id : null
    try {
      if (kind === 'user/message') {
        const sourceKind = event?.data?.source?.kind
        // 真人来源：浏览器/CLI 会话没有 source，插件通道是 plugin:*（QQ 就是 plugin:dsh-onebot）。
        if (sourceKind !== undefined && sourceKind !== 'user' && !String(sourceKind).startsWith('plugin:')) return
        engine.noteTurnContext({ sessionId, kind: 'user', text: messageText(event) })
        return
      }
      // 只拿失败的调用结果：成功的输出大多是文件内容、日志，词面噪声太大。
      if (event?.data?.message?.isError !== true) return
      engine.noteTurnContext({ sessionId, kind: 'tool', text: messageText(event) })
    } catch (error) {
      log('warn', `记录当轮上下文失败：${message(error)}`)
    }
  }), 'memory-plugin:turn-context')

  // 即时信号：只入队提醒，不直接写记忆。session/event 是 post-commit，
  // 用户消息和助手消息都能拿到；子智能体会话不参与，避免审计子会话自我触发。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const cfg = engine.getSettings().autoCapture
    if (cfg?.enabled !== true || cfg?.immediate !== true) return
    const origin = session?.header?.origin ?? session?.origin ?? session?.header?.kind
    if (origin === 'subagent' || origin === 'subagent-run') return
    const sessionId = typeof session?.id === 'string' ? session.id : null
    const kind = event?.type
    // 宿主通知、定时任务、注入上下文也会走 user/message；只处理真正的用户输入，
    // 否则系统消息里的“记住/错了”会误触发捕获。
    const sourceKind = event?.data?.source?.kind
    if (kind === 'user/message' && sourceKind !== undefined && sourceKind !== 'user') return
    const signalList = kind === 'user/message'
      ? detectUserSignals(messageText(event))
      : kind === 'assistant/message' ? detectAssistantSignals(messageText(event)) : []
    for (const signal of signalList) {
      void engine.noteCaptureSignal({
        ...signal,
        text: messageText(event),
        sessionId,
      }).catch((error) => log('warn', `记录记忆信号失败：${message(error)}`))
    }
  }), 'memory-plugin:capture-events')

  // 小/大定时：每 5 分钟检查一次是否该入队小时/每日回顾。
  ctx.effect(() => {
    const tick = () => {
      void engine.tickCapture().then((result) => {
        if ((result.queued ?? []).length > 0) {
          log('info', `自动记忆回顾已入队：${result.queued.map((entry) => entry.trigger).join('、')}`)
        }
      }).catch((error) => log('warn', `自动记忆定时检查失败：${message(error)}`))
    }
    tick()
    const timer = setInterval(tick, 5 * 60 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'memory-plugin:capture-timer')

  // 定时维护：过期清理 / 轮转 / 归档 / 去重 / 反思提升 / 资源上限。
  ctx.effect(() => {
    const current = engine.getSettings()
    if (!current.maintenance.autoRun) return () => {}
    const hours = Math.max(1, current.maintenance.intervalHours)
    const timer = setInterval(() => {
      ;(async () => {
        try {
          const report = await engine.runMaintenance({ tasks: ['limits', 'cleanup', 'rotate', 'archive', 'dedupe', 'reflect', 'consolidate', 'compact'] })
          const changed = report.tasks.reduce((sum, task) => sum + (task.changed ?? 0), 0)
          if (changed > 0) log('info', `定时维护完成：${report.tasks.map((task) => task.note).join('；')}`)
          // 用户可能在设置页改了间隔或关掉了自动维护。
          if (!engine.getSettings().maintenance.autoRun) clearInterval(timer)
        } catch (error) {
          log('warn', `定时维护失败：${message(error)}`)
        }
      })()
    }, hours * 3600 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'memory-plugin:maintenance')

  // 定时自动备份（参考代码2 §3：数据库备份是"非常重要"项）。
  ctx.effect(() => {
    const current = engine.getSettings()
    const hours = Math.max(1, current.storage.autoBackupHours ?? 24)
    if (current.storage.autoBackup === false) return () => {}
    if (typeof store.backup !== 'function') return () => {}
    const timer = setInterval(() => {
      try {
        const result = store.backup('auto')
        log('info', `自动备份完成：${result.path}`)
      } catch (error) {
        log('warn', `自动备份失败：${message(error)}`)
      }
    }, hours * 3600 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'memory-plugin:backup')

  attachApi(ctx, engine, store, debug)
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

function attachApi(ctx, engine, store, debug) {
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
        const routeDispose = mountApi(webServer, () => holder.engine, apiLog, { store })
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
        () => mountApi(webServer, () => holder.engine, apiLog, { store, path: LEGACY_API_PATH }),
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

/** 把一行诊断写到 <storageDir>/plugin.log（截断到 64KB），同时走宿主 logger 与结构化日志。 */
function createDebugLog(store, log) {
  let file
  try {
    file = join(store.dir, 'plugin.log')
  } catch {
    file = undefined
  }
  return (line) => {
    try {
      log('info', line, 'step')
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



