/**
 * 记忆数据的落盘层。
 *
 * 位置：`<DSH_HOME>/storages/dsh-memory-plugin/store.json`
 *   —— 优先用 Harness 发布的 `dshHomePath` 解析器，拿不到就退回 $DSH_HOME / ~/.dsh。
 *   设置里填了 `storage.dir` 时以它为准（重启插件后生效）。
 *
 * 为什么不用 profile 的 `cordis.patch.yml` 存数据：那是用户拥有的配置文件，
 * 插件每次写都会和配置编辑器打架、丢注释。插件自己的 JSON 文件归插件所有，
 * 语义清楚：设置页的选择优先于 patch 行，删掉文件就回到出厂默认。
 *
 * 写盘策略：先写同目录的 `.tmp` 再 `rename`（原子替换），写之前按份数轮转备份。
 * 所有失败都不致命 —— 插件在内存里继续工作，只是这次没落盘。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const STORE_FILE = 'store.json'
export const STORE_VERSION = 1

/** 解析数据文件路径。 */
export function resolveStorePath(ctx, settings) {
  const override = typeof settings?.storage?.dir === 'string' ? settings.storage.dir.trim() : ''
  if (override !== '') return join(override, STORE_FILE)
  try {
    const homePath = ctx?.get?.('dshHomePath')
    if (typeof homePath === 'function') return homePath('storages', 'dsh-memory-plugin', STORE_FILE)
  } catch {
    /* 退回环境变量 */
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-memory-plugin', STORE_FILE)
}

/** 空状态。 */
export function emptyState(settings) {
  const now = new Date().toISOString()
  return {
    version: STORE_VERSION,
    createdAt: now,
    updatedAt: now,
    settings,
    items: [],
    audit: [],
    meta: {
      lastMaintenance: null,
      lastReflect: null,
      lastCleanup: null,
      writes: 0,
      searches: 0,
      lastError: null,
      audit: { version: 1, runs: [] },
    },
  }
}

/**
 * 创建一个持久化句柄。
 *
 * @param ctx   Cordis 上下文（只用于解析路径）。
 * @param log   `(level, text) => void`。
 * @param getSettings 读取当前设置的函数（决定 storage.dir / backupKeep）。
 */
export function createStore(ctx, log, getSettings) {
  const settingsOf = () => (typeof getSettings === 'function' ? getSettings() : undefined)
  let path = resolveStorePath(ctx, settingsOf())

  const store = {
    get path() {
      return path
    },
    /** 数据目录（备份、诊断文件都放这里）。 */
    get dir() {
      return dirname(path)
    },
    /** 设置里的目录改过之后重新解析路径。 */
    refreshPath() {
      const next = resolveStorePath(ctx, settingsOf())
      if (next !== path) {
        path = next
        return true
      }
      return false
    },
    /** 文件信息，设置页展示用。 */
    info() {
      try {
        const stat = statSync(path)
        return { engine: 'json', path, dir: dirname(path), exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
      } catch {
        return { engine: 'json', path, dir: dirname(path), exists: false, bytes: 0, modifiedAt: null }
      }
    },
    /**
     * 读取状态。文件不存在、损坏、版本不认识时返回 `undefined`，
     * 由调用方决定用空状态还是报错。
     */
    read() {
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object') return undefined
        return parsed
      } catch (error) {
        log('warn', `store.json 解析失败（${message(error)}），本次按空数据启动；下一次保存会覆盖它`)
        try {
          copyFileSync(path, `${path}.corrupt-${Date.now()}`)
        } catch {
          /* 尽力而为 */
        }
        return undefined
      }
    },
    /** 原子写入。返回写入时间戳，失败返回 undefined。 */
    write(state) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        rotateBackups(path, settingsOf()?.storage?.backupKeep ?? 0)
        const updatedAt = new Date().toISOString()
        state.updatedAt = updatedAt
        const tmp = `${path}.tmp`
        writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
        renameSync(tmp, path)
        return updatedAt
      } catch (error) {
        log('warn', `写入 ${path} 失败：${message(error)}`)
        return undefined
      }
    },
  }
  return store
}

/** 把当前文件轮转成 store.bak-1.json … store.bak-N.json。 */
function rotateBackups(path, keep) {
  const count = Number.isFinite(keep) ? Math.max(0, Math.min(20, Math.trunc(keep))) : 0
  if (count === 0 || !existsSync(path)) return
  for (let index = count; index >= 2; index -= 1) {
    const from = `${path}.bak-${index - 1}`
    const to = `${path}.bak-${index}`
    if (!existsSync(from)) continue
    try {
      copyFileSync(from, to)
    } catch {
      /* 备份失败不阻塞保存 */
    }
  }
  try {
    copyFileSync(path, `${path}.bak-1`)
  } catch {
    /* 同上 */
  }
}

/** 删除临时文件（测试与手动修复用）。 */
export function removeQuietly(file) {
  try {
    unlinkSync(file)
  } catch {
    /* 不存在就算了 */
  }
}

export function message(error) {
  return error instanceof Error ? error.message : String(error)
}

