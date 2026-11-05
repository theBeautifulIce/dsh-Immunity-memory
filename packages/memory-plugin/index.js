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
import { Config, normalizeSettings } from './lib/settings.js'
import { createStore, message } from './lib/store.js'
import { createEngine } from './lib/engine.js'
import { mountApi, setTrustedHosts } from './lib/api.js'
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

  attachApi(ctx, engine, log)
}

/** 把 HTTP 接口挂到 webServer 上（webServer 可能比本插件晚装载）。 */
function attachApi(ctx, engine, log) {
  const attach = (holder) => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    try {
      const runtime = ctx.get('webRuntime') ?? ctx.get('webApp')
      setTrustedHosts(runtime?.trustedHosts ?? [])
    } catch {
      // 拿不到可信域时退回回环判断
    }
    let lastError
    const register = () => {
      try {
        const dispose = mountApi(webServer, engine, log)
        holder.dispose = dispose
        holder.controller = true
        return true
      } catch (error) {
        lastError = error
        return false
      }
    }
    if (register()) {
      log('info', '记忆接口已挂载：/memory-plugin/api')
      return
    }
    // 行热重载后旧代的同名路由可能还没释放，短暂退避后重试。
    const delays = [0, 250, 1000, 3000]
    for (const delay of delays) {
      const timer = setTimeout(() => {
        if (register()) log('info', '记忆接口挂载成功（重试）')
      }, delay)
      timer.unref?.()
    }
    log('warn', `记忆接口首次挂载失败，将重试：${message(lastError)}`)
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], () => attach())
    } catch (error) {
      log('warn', `等待 webServer 失败：${message(error)}`)
    }
  } else {
    attach()
  }
}
