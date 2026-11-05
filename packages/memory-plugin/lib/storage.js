/**
 * 存储选择：默认 SQLite（设计文档 §7.1），JSON 作为显式选择或运行时回退。
 *
 * 两者对外接口一致（path / dir / info / read / write / refreshPath / close），
 * 引擎与接口层不需要关心底下是谁。
 */
import { createStore, message } from './store.js'
import { createSqliteStore } from './sqlite.js'

export const STORAGE_ENGINES = ['sqlite', 'json']

/**
 * @returns {{ kind: 'sqlite' | 'json', store: object, reason?: string }}
 */
export function createStorage(ctx, log, getSettings) {
  const settings = typeof getSettings === 'function' ? getSettings() : undefined
  const requested = settings?.storage?.engine === 'json' ? 'json' : 'sqlite'

  if (requested === 'sqlite') {
    try {
      const store = createSqliteStore(ctx, log, getSettings)
      log('info', '存储引擎：SQLite（node:sqlite）')
      return { kind: 'sqlite', store }
    } catch (error) {
      log('warn', `SQLite 不可用，回退到 JSON 存储：${message(error)}`)
      return { kind: 'json', store: createStore(ctx, log, getSettings), reason: message(error) }
    }
  }

  log('info', '存储引擎：JSON（设置里显式选择）')
  return { kind: 'json', store: createStore(ctx, log, getSettings) }
}
