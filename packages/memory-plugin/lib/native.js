/**
 * 原生计算核心的 Node 客户端（对应架构文档里的 Rust 计算库）。
 *
 * 二进制由 `scripts/build-native.mjs` 构建到 `native/<platform>-<arch>/`。
 * 运行方式是一个常驻子进程 + JSON lines 协议：
 *   - 批量余弦相似度（语义检索重排、去重、冲突检测）
 *   - 批量重要性评分（轮转清理、反思提升）
 *
 * 高可用：
 *   - 找不到二进制 / 无法启动 → 全部退回纯 JS 实现，功能不丢（只是慢一点）；
 *   - 进程崩溃 → 60 秒窗口内最多重启 5 次（参考代码2 §6 的策略），超限后停止重启并降级；
 *   - 单次调用超时（默认 5s）会杀掉进程并按失败处理，调用方拿 JS 结果。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fallbackCosineBatch, fallbackDedupe, fallbackImportance } from './fallback-math.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 5
const DEFAULT_TIMEOUT_MS = 5_000

/** 平台目录名：win32-x64 / linux-x64 / darwin-arm64 … */
export function platformTag() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  return `${process.platform}-${arch}`
}

/** 二进制路径；允许用环境变量覆盖（调试用）。 */
export function resolveBinary() {
  const override = process.env.DSH_MEMORY_CORE
  if (typeof override === 'string' && override !== '') return override
  const name = process.platform === 'win32' ? 'memory-core.exe' : 'memory-core'
  return join(PACKAGE_ROOT, 'native', platformTag(), name)
}

/**
 * 创建一个原生核心句柄（不会立即启动进程，第一次调用时才启动）。
 *
 * @param {{ log?: (level: string, text: string) => void, timeoutMs?: number }} options
 */
export function createNativeCore(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const binary = resolveBinary()

  let child = null
  let ready = null
  let nextId = 1
  let restarts = 0
  let restartWindowStart = 0
  let lastError = null
  let closed = false
  let version = null
  let protocol = null
  const pending = new Map()

  const health = () => ({
    available: child !== null && child.exitCode === null,
    binary,
    version,
    protocol,
    pid: child?.pid ?? null,
    restarts,
    lastError,
    fallback: child === null,
  })

  const failPending = (reason) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
      pending.delete(id)
    }
  }

  const handleLine = (line) => {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      log('warn', `原生核心返回了非法 JSON：${String(error)}`)
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok === true) entry.resolve(message.result)
    else entry.reject(new Error(message.error ?? 'native core error'))
  }

  const start = () => {
    if (closed) return Promise.reject(new Error('native core closed'))
    if (ready !== null) return ready
    if (!existsSync(binary)) {
      lastError = `未找到原生核心：${binary}`
      ready = Promise.reject(new Error(lastError))
      ready.catch(() => {})
      return ready
    }
    ready = new Promise((resolve, reject) => {
      let stdout = ''
      let settled = false
      let proc
      try {
        proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        lastError = `spawn 失败：${String(error)}`
        reject(new Error(lastError))
        return
      }
      child = proc
      const bootTimer = setTimeout(() => {
        if (settled) return
        settled = true
        lastError = '原生核心启动超时'
        try {
          proc.kill()
        } catch {
          /* 已退出 */
        }
        reject(new Error(lastError))
      }, timeoutMs)

      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        stdout += chunk
        let index = stdout.indexOf('\n')
        while (index >= 0) {
          const line = stdout.slice(0, index)
          stdout = stdout.slice(index + 1)
          if (!settled) {
            // 第一条消息只可能是启动时 ping 的响应
            try {
              const parsed = JSON.parse(line)
              if (parsed.ok === true) {
                settled = true
                clearTimeout(bootTimer)
                version = parsed.result?.version ?? null
                protocol = parsed.result?.protocol ?? null
                log('info', `原生核心已启动（v${version}，protocol ${protocol}，pid ${proc.pid}）`)
                resolve(true)
                return
              }
              throw new Error(parsed.error ?? 'ping failed')
            } catch (error) {
              settled = true
              clearTimeout(bootTimer)
              lastError = `原生核心握手失败：${String(error)}`
              try {
                proc.kill()
              } catch {
                /* 已退出 */
              }
              reject(new Error(lastError))
              return
            }
          }
          handleLine(line)
          index = stdout.indexOf('\n')
        }
      })
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') log('warn', `原生核心 stderr：${text.slice(0, 300)}`)
      })
      proc.on('error', (error) => {
        lastError = `原生核心进程错误：${String(error)}`
        if (!settled) {
          settled = true
          clearTimeout(bootTimer)
          reject(new Error(lastError))
        }
      })
      proc.on('exit', (code) => {
        const wasReady = settled
        child = null
        ready = null
        failPending(`原生核心退出（code ${code}）`)
        if (!wasReady) return
        if (closed) return
        lastError = `原生核心退出（code ${code}）`
        scheduleRestart()
      })

      // 启动握手
      proc.stdin.write(`${JSON.stringify({ id: 0, cmd: 'ping' })}\n`)
    })
    ready.catch(() => {
      ready = null
    })
    return ready
  }

  const scheduleRestart = () => {
    const now = Date.now()
    if (now - restartWindowStart > RESTART_WINDOW_MS) {
      restartWindowStart = now
      restarts = 0
    }
    if (restarts >= MAX_RESTARTS) {
      log('warn', `原生核心在 ${RESTART_WINDOW_MS / 1000}s 内重启 ${MAX_RESTARTS} 次，停止重启并降级到 JS`)
      return
    }
    restarts += 1
    const delay = Math.min(5000, 200 * 2 ** (restarts - 1))
    setTimeout(() => {
      if (closed) return
      start().catch((error) => log('warn', `原生核心重启失败：${String(error)}`))
    }, delay).unref?.()
  }

  /** 发一条请求；原生不可用时抛出，由调用方走 fallback。 */
  const request = async (cmd, payload) => {
    await start()
    const id = nextId++
    const line = `${JSON.stringify({ id, cmd, ...payload })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        lastError = `原生核心调用超时（${cmd}）`
        try {
          child?.kill()
        } catch {
          /* 已退出 */
        }
        reject(new Error(lastError))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(line)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const cosine = async (query, matrix, count, dim) => {
    try {
      const queryB64 = Buffer.from(query.buffer, query.byteOffset, query.byteLength).toString('base64')
      const matrixB64 = Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength).toString('base64')
      const result = await request('cosine', { dim, count, queryB64, matrixB64 })
      const scores = result?.scores
      if (!Array.isArray(scores) || scores.length !== count) throw new Error('原生核心返回的分数数量不对')
      return Float32Array.from(scores)
    } catch (error) {
      lastError = String(error)
      return fallbackCosineBatch(query, matrix, count, dim)
    }
  }

  const importance = async (items, nowSeconds) => {
    try {
      const result = await request('importance', { now: nowSeconds, items })
      const scores = result?.scores
      if (!Array.isArray(scores) || scores.length !== items.length) throw new Error('原生核心返回的重要性数量不对')
      return Float32Array.from(scores)
    } catch (error) {
      lastError = String(error)
      return fallbackImportance(items, nowSeconds)
    }
  }

  const dedupe = async (items, threshold) => {
    try {
      const result = await request('dedupe', { threshold, items })
      return Array.isArray(result?.pairs) ? result.pairs : fallbackDedupe(items, threshold)
    } catch (error) {
      lastError = String(error)
      return fallbackDedupe(items, threshold)
    }
  }

  const similar = async (tokens, candidates) => {
    try {
      const result = await request('similar', { tokens, candidates })
      return Array.isArray(result?.scores) ? result.scores : candidates.map((candidate) => ({ id: candidate.id, score: 0 }))
    } catch (error) {
      lastError = String(error)
      return candidates.map((candidate) => ({ id: candidate.id, score: 0 }))
    }
  }

  const close = () => {
    closed = true
    failPending('原生核心已关闭')
    try {
      child?.kill()
    } catch {
      /* 已退出 */
    }
    child = null
    ready = null
  }

  /**
   * 预热：立刻启动并握手，让设置页能显示真实状态（否则第一次用到前都显示"JS 兜底"）。
   * 启动失败只记录 lastError，不抛错。
   */
  const warmup = async () => {
    try {
      await start()
    } catch (error) {
      lastError = lastError ?? String(error)
    }
    return health()
  }

  return { health, warmup, cosine, importance, dedupe, similar, close, binary }
}
