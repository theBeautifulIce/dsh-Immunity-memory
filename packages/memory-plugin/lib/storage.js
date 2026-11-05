/**
 * 存储选择（按架构文档的层次）：
 *
 *   1. Go 服务（默认）—— 拥有 SQLite 持久化、FTS5 检索、图谱遍历、清理任务；
 *   2. Node 内置 SQLite（回退）—— Go 二进制缺失或启动失败时；
 *   3. JSON 单文件（最后回退）—— 显式选择，或运行环境连 node:sqlite 都没有时。
 *
 * 三个实现对外接口一致：path / dir / info() / load()|read() / apply()|write() /
 * refreshPath() / close()。引擎只认"远程（load/apply）"和"本地（read/write）"两种形态。
 */
import { createStore, message } from './store.js'
import { createSqliteStore } from './sqlite.js'
import { existsSync } from 'node:fs'
import { createGoStore, resolveServiceBinary } from './go-store.js'

export const STORAGE_ENGINES = ['auto', 'go', 'sqlite', 'json']

/**
 * @returns {Promise<{ kind: 'go' | 'sqlite' | 'json', store: object, reason?: string }>}
 */
export async function createStorage(ctx, log, getSettings) {
  const settings = typeof getSettings === 'function' ? getSettings() : undefined
  const requested = settings?.storage?.engine ?? 'auto'

  if (requested === 'auto' || requested === 'go') {
    const binary = resolveServiceBinary()
    if (existsSync(binary)) {
      try {
        const store = createGoStore(ctx, log, getSettings)
        await store.ready()
        log('info', '存储引擎：Go 服务（SQLite + FTS5 + 图谱）')
        return { kind: 'go', store }
      } catch (error) {
        log('warn', `Go 服务不可用，回退到 Node 内置 SQLite：${message(error)}`)
      }
    } else if (requested === 'go') {
      log('warn', `未找到 Go 服务二进制（${binary}），回退到 Node 内置 SQLite`)
    }
  }

  if (requested !== 'json') {
    try {
      const store = createSqliteStore(ctx, log, getSettings)
      log('info', '存储引擎：Node 内置 SQLite（回退）')
      return { kind: 'sqlite', store }
    } catch (error) {
      log('warn', `Node 内置 SQLite 不可用，回退到 JSON：${message(error)}`)
      return { kind: 'json', store: createStore(ctx, log, getSettings), reason: message(error) }
    }
  }

  log('info', '存储引擎：JSON（设置里显式选择）')
  return { kind: 'json', store: createStore(ctx, log, getSettings) }
}
