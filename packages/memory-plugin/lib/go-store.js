/**
 * Go 服务客户端（Node 控制层 → Go 服务层）。
 *
 * 架构文档把持久化、全文检索、图谱遍历、清理任务交给 Go 服务；这里就是那条通道：
 *   1. 启动 `bin/<platform>-<arch>/memory-service`，读它 stdout 的握手行拿到端口；
 *   2. 每次请求带 x-memory-token（随机生成，只在本机回环用）；
 *   3. 把引擎的状态变化按行签名做增量同步（upsert / delete / config / audit）；
 *   4. 检索直接调用 Go 的 FTS5 + 向量 + 图谱融合接口。
 *
 * 高可用：二进制缺失、启动失败、请求连续失败时，storage 层会退回 Node 内置实现，
 * 功能不丢；这条路径只作为兜底，不是默认。
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { message } from './store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
export const HANDLER_TIMEOUT_MS = 10_000

/** 平台目录名（win32-x64 / linux-x64 / darwin-arm64 …）。 */
export function platformTag() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  return `${process.platform}-${arch}`
}

/** Go 服务二进制路径；允许用环境变量覆盖。 */
export function resolveServiceBinary() {
  const override = process.env.DSH_MEMORY_SERVICE
  if (typeof override === 'string' && override !== '') return override
  const name = process.platform === 'win32' ? 'memory-service.exe' : 'memory-service'
  return join(PACKAGE_ROOT, 'bin', platformTag(), name)
}

/** 解析数据库路径（与 Node 侧 SQLite 回退保持同一位置）。 */
export function resolveDatabasePath(ctx, settings) {
  const override = typeof settings?.storage?.dir === 'string' ? settings.storage.dir.trim() : ''
  if (override !== '') return join(override, 'memory.sqlite3')
  try {
    const homePath = ctx?.get?.('dshHomePath')
    if (typeof homePath === 'function') return homePath('storages', 'dsh-memory-plugin', 'memory.sqlite3')
  } catch {
    /* 退回环境变量 */
  }
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'storages', 'dsh-memory-plugin', 'memory.sqlite3')
}

/** 条目签名：与 sqlite 回退层保持同样的增量判断口径。 */
function auditSignature(entry) {
  return `${entry.at}|${entry.action}|${entry.change?.itemId ?? ''}|${entry.change?.operation ?? ''}`
}

function itemSignature(item) {
  return [
    item.updatedAt ?? '',
    item.version ?? 1,
    item.accessCount ?? 0,
    item.status ?? '',
    item.importance ?? 5,
    item.layer ?? '',
    item.ttlDays ?? '',
    item.pinned === true ? 1 : 0,
    item.expiresAt ?? '',
    JSON.stringify(item.conflicts ?? []),
    JSON.stringify(item.source ?? null),
    item.key ?? '',
    JSON.stringify(item.supersedes ?? []),
    item.supersededBy ?? '',
    item.validFrom ?? '',
    item.validTo ?? '',
    item.title ?? '',
    (item.content ?? '').length,
  ].join('|')
}

/**
 * 把服务二进制放到数据目录再启动。
 *
 * 不直接从安装路径运行的原因有两个：
 *   1. 开发态 `link:` 安装时，安装路径就是仓库里（或 workspace 里）的二进制，
 *      宿主沙箱只给 workspace 内的可执行文件 workspace 写权限，子进程打不开
 *      用户目录下的数据库（SQLite 报 unable to open database file）；
 *   2. 正式安装也可能落在只读目录 / asar 里，从数据目录运行最稳。
 * 复制按「大小 + 修改时间 + 内容哈希」判断，升级时自动替换；替换失败（旧进程占着
 * 文件）就继续用旧副本，不影响本次启动。
 */
export function stageServiceBinary(source, dbPath, log) {
  if (process.env.DSH_MEMORY_SERVICE) return source
  try {
    const name = process.platform === 'win32' ? 'memory-service.exe' : 'memory-service'
    const dir = join(dirname(dbPath), 'service', platformTag())
    mkdirSync(dir, { recursive: true })
    const target = join(dir, name)
    const stampFile = `${target}.stamp`
    const stat = statSync(source)
    const stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`
    if (existsSync(target) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) {
      return target
    }
    const temp = `${target}.new-${process.pid}`
    copyFileSync(source, temp)
    if (hashFile(source) !== hashFile(temp)) {
      rmSync(temp, { force: true })
      throw new Error('复制后的二进制校验不一致')
    }
    try {
      renameSync(temp, target)
    } catch (error) {
      // 旧副本可能正被上一次的进程占用；留着旧副本继续用。
      rmSync(temp, { force: true })
      if (existsSync(target)) {
        log('warn', `更新数据目录里的 Go 服务失败，继续使用旧副本：${message(error)}`)
        return target
      }
      throw error
    }
    writeFileSync(stampFile, stamp)
    log('info', `Go 服务已就位：${target}`)
    return target
  } catch (error) {
    log('warn', `无法把 Go 服务放到数据目录，改为从安装路径启动：${message(error)}`)
    return source
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 启动 Go 服务并创建存储句柄。
 */
export function createGoStore(ctx, log, getSettings) {
  const source = resolveServiceBinary()
  if (!existsSync(source)) throw new Error(`未找到 Go 服务：${source}（先运行 node scripts/build-go.mjs）`)
  const dbPath = resolveDatabasePath(ctx, getSettings?.())
  mkdirSync(dirname(dbPath), { recursive: true })
  const binary = stageServiceBinary(source, dbPath, log)
  const token = randomBytes(16).toString('hex')

  let child = null
  let port = 0
  let serviceVersion = null
  let ready = null
  let closed = false
  let knownItems = new Map()
  let knownAudit = []
  let knownSettings = ''
  let knownMeta = ''
  let knownCreatedAt = ''
  let lastError = null

  const request = async (path, body) => {
    if (closed) throw new Error('Go 服务已关闭')
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-memory-token': token },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(HANDLER_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => null)
    if (payload === null || payload.ok !== true) {
      const reason = payload?.error?.message ?? `HTTP ${response.status}`
      throw new Error(`${path} 失败：${reason}`)
    }
    return payload
  }

  const start = () => {
    if (ready !== null) return ready
    ready = new Promise((resolve, reject) => {
      let stdout = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        lastError = 'Go 服务启动超时'
        try {
          child?.kill()
        } catch {
          /* 已退出 */
        }
        reject(new Error(lastError))
      }, HANDLER_TIMEOUT_MS)
      try {
        child = spawn(binary, ['-db', dbPath, '-token', token], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        clearTimeout(timer)
        settled = true
        reject(new Error(`启动 Go 服务失败：${message(error)}`))
        return
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        const index = stdout.indexOf('\n')
        if (index < 0 || settled) return
        const line = stdout.slice(0, index)
        settled = true
        clearTimeout(timer)
        try {
          const handshake = JSON.parse(line)
          port = handshake.port
          serviceVersion = handshake.version
          log('info', `Go 记忆服务已启动（pid ${handshake.pid}，port ${port}，v${serviceVersion}）`)
          resolve(true)
        } catch (error) {
          reject(new Error(`握手解析失败：${message(error)}`))
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') log('warn', `Go 服务：${text.slice(0, 300)}`)
      })
      child.on('error', (error) => {
        lastError = `Go 服务进程错误：${message(error)}`
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(lastError))
        }
      })
      child.on('exit', (code) => {
        child = null
        ready = null
        if (!closed) lastError = `Go 服务退出（code ${code}）`
      })
    })
    ready.catch(() => {
      ready = null
    })
    return ready
  }

  const ensure = async () => {
    await start()
  }

  const store = {
    engine: 'go',
    get path() {
      return dbPath
    },
    get dir() {
      return dirname(dbPath)
    },
    get service() {
      return { port, pid: child?.pid ?? null, version: serviceVersion }
    },
    /** 启动服务但不读数据（storage 层选引擎时先探活）。 */
    async ready() {
      await ensure()
      return true
    },
    /** 桥接接口：engine 用 load/apply/search。 */
    async load() {
      await ensure()
      const snapshot = await request('/snapshot', {})
      const state = snapshot.state
      knownItems = new Map((state.items ?? []).map((item) => [item.id, itemSignature(item)]))
      knownAudit = (state.audit ?? []).map(auditSignature)
      knownSettings = JSON.stringify(state.settings ?? {})
      knownMeta = JSON.stringify(state.meta ?? {})
      knownCreatedAt = state.createdAt ?? ''
      return state
    },
    async apply(state) {
      await ensure()
      const items = Array.isArray(state.items) ? state.items : []
      const upserts = []
      const seen = new Set()
      for (const item of items) {
        seen.add(item.id)
        const signature = itemSignature(item)
        if (knownItems.get(item.id) === signature) continue
        upserts.push(item)
        knownItems.set(item.id, signature)
      }
      const deletes = []
      for (const id of [...knownItems.keys()]) {
        if (seen.has(id)) continue
        deletes.push(id)
        knownItems.delete(id)
      }
      for (let offset = 0; offset < upserts.length; offset += 200) {
        await request('/items/upsert', { items: upserts.slice(offset, offset + 200) })
      }
      if (deletes.length > 0) await request('/items/delete', { ids: deletes })

      const settings = JSON.stringify(state.settings ?? {})
      if (settings !== knownSettings) {
        await request('/config', { key: 'settings', value: state.settings ?? {} })
        knownSettings = settings
      }
      const meta = JSON.stringify(state.meta ?? {})
      if (meta !== knownMeta) {
        await request('/config', { key: 'meta', value: state.meta ?? {} })
        knownMeta = meta
      }
      if ((state.createdAt ?? '') !== knownCreatedAt) {
        await request('/config', { key: 'createdAt', value: state.createdAt ?? '' })
        knownCreatedAt = state.createdAt ?? ''
      }
      const audit = Array.isArray(state.audit) ? state.audit : []
      const nextAudit = audit.map(auditSignature)
      const prefixMatch = nextAudit.length >= knownAudit.length
        && knownAudit.every((entry, index) => nextAudit[index] === entry)
      if (prefixMatch) {
        const appended = audit.slice(knownAudit.length)
        if (appended.length > 0) await request('/audit/append', { entries: appended })
      } else if (audit.length > 0 || knownAudit.length > 0) {
        await request('/audit/replace', { entries: audit })
      }
      knownAudit = nextAudit
      return new Date().toISOString()
    },
    /** 混合检索：FTS5 + 语义 + 图谱 + 融合全部在 Go 服务里完成。 */
    async search(options) {
      await ensure()
      const payload = {
        query: options.query,
        limit: options.limit,
        filters: {
          layer: options.layer ?? '',
          type: options.type ?? '',
          notebook: options.notebook ?? '',
          status: options.status ?? '',
          tags: options.tags ?? [],
        },
        weights: options.weights ?? { fulltext: 0.4, semantic: 0.4, graph: 0.2 },
        semantic: options.semantic !== false,
        graph: options.graph !== false,
        graphDepth: options.graphDepth ?? 2,
        graphSeeds: options.graphSeeds ?? 5,
        graphMinWeight: options.graphMinWeight ?? 0.5,
        candidateCap: options.candidateCap ?? 400,
      }
      const result = await request('/search', payload)
      return {
        hits: result.hits ?? [],
        weights: result.weights,
        tookMs: result.tookMs ?? 0,
        total: result.total ?? (result.hits ?? []).length,
      }
    },
    /** 与某条目直接相连的边（自动 related + 人工 manual）。 */
    async links(id, options = {}) {
      await ensure()
      const text = String(id ?? '')
      if (text === '') return []
      const result = await request('/links/list', {
        id: text,
        minWeight: options.minWeight ?? 0,
        limit: options.limit ?? 200,
      })
      return Array.isArray(result.links) ? result.links : []
    },
    /** 写一条人工关联边（edge_type='manual'）。 */
    async linkItems(params = {}) {
      await ensure()
      const result = await request('/links/upsert', {
        sourceId: String(params.sourceId ?? ''),
        targetId: String(params.targetId ?? ''),
        weight: params.weight ?? 1,
      })
      return result.link
    },
    /** 删除一对条目之间的人工关联边，返回删掉的行数。 */
    async unlinkItems(params = {}) {
      await ensure()
      const result = await request('/links/delete', {
        sourceId: String(params.sourceId ?? ''),
        targetId: String(params.targetId ?? ''),
      })
      return Number(result.removed ?? 0)
    },
    async graphBfs(seeds, options = {}) {
      await ensure()
      const result = await request('/graph/bfs', {
        seeds,
        depth: options.depth ?? 2,
        minWeight: options.minWeight ?? 0.5,
        maxResults: options.maxResults ?? 50,
      })
      return result
    },
    info() {
      try {
        const stat = statSync(dbPath)
        return {
          engine: 'go',
          path: dbPath,
          dir: dirname(dbPath),
          exists: true,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          service: store.service,
          fts: true,
          vectors: true,
        }
      } catch {
        return { engine: 'go', path: dbPath, dir: dirname(dbPath), exists: false, bytes: 0, modifiedAt: null, service: store.service, fts: true, vectors: true }
      }
    },
    async stats() {
      await ensure()
      const health = await request('/health', {})
      const stats = await request('/stats', {})
      return { ...stats.stats, integrity: stats.integrity, version: health.version, uptimeSeconds: health.uptimeSeconds }
    },
    async verify() {
      await ensure()
      const result = await request('/verify', {})
      return { ok: result.integrity === true, verdict: result.verdict }
    },
    async backup(tag = 'manual') {
      await ensure()
      const result = await request('/backup', { tag })
      return result.backup
    },
    async listBackups() {
      await ensure()
      const result = await request('/backups', {})
      return result.backups ?? []
    },
    async restore(name) {
      await ensure()
      return request('/restore', { name })
    },
    async close() {
      if (closed) return
      closed = true
      const target = child
      try {
        if (target !== null && port !== 0) {
          await fetch(`http://127.0.0.1:${port}/shutdown`, {
            method: 'POST',
            headers: { 'x-memory-token': token },
            signal: AbortSignal.timeout(1000),
          }).catch(() => {})
        }
      } catch {
        /* 忽略 */
      }
      // 必须等进程真正退出：Windows 上 SQLite 文件句柄要等进程结束后才释放，
      // 否则紧接着的备份目录清理/重装会报 EBUSY。
      const exited = target === null || target.exitCode !== null || target.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => {
            const timer = setTimeout(resolve, 3000)
            target.once('exit', () => {
              clearTimeout(timer)
              resolve()
            })
          })
      try {
        target?.kill()
      } catch {
        /* 已退出 */
      }
      await exited
      child = null
      ready = null
    },
  }
  return store
}

