/**
 * SQLite 持久层 + 语义向量表（设计文档 §7.1 / §7.2 的落地）。
 *
 * 关于全文索引：设计文档写的是 SQLite FTS5，但 DSH 宿主自带的 `node:sqlite`
 * 编译时没有启用 FTS5（`no such module: fts5`）。所以全文检索放在
 * lib/search.js 的内存倒排索引里（BM25 打分，见该文件），SQLite 只负责
 * 持久化与向量存储。等宿主 SQLite 支持 FTS5 时，把索引搬到库里即可，接口不变。
 *
 * 能力：
 *   - 表结构：memories / events / assets / relationships / changelog / config
 *   - 版本化迁移（schema_migrations 记录 description / applied_at，事务内按版本顺序执行）
 *   - 向量表 memory_vectors（Float32 BLOB，语义检索用）
 *   - WAL + 预编译语句缓存 + 事务写入 + busy 重试
 *   - 备份目录、完整性校验、损坏自动从备份恢复、资源上限
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { embed, DEFAULT_DIM, vectorToBuffer, bufferToVector } from './embeddings.js'
import { ftsText } from './text.js'
import { message } from './store.js'

export const DB_FILE = 'memory.sqlite3'
export const LEGACY_JSON_FILE = 'store.json'
export const SCHEMA_VERSION = 2
export const BACKUP_DIR = 'backups'

const BASE_TABLES = [
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     layer TEXT NOT NULL,
     type TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     content TEXT NOT NULL,
     metadata TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_accessed TEXT,
     access_count INTEGER NOT NULL DEFAULT 0,
     importance_score REAL NOT NULL DEFAULT 0.5,
     confidence REAL,
     freshness_period INTEGER,
     status TEXT NOT NULL DEFAULT 'active'
   )`,
  'CREATE INDEX IF NOT EXISTS idx_memories_layer_type ON memories (layer, type)',
  'CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at, last_accessed)',
  'CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance_score DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status)',
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     timestamp TEXT NOT NULL,
     event_type TEXT NOT NULL,
     title TEXT,
     summary TEXT,
     content TEXT,
     tags TEXT,
     participants TEXT,
     importance REAL DEFAULT 0.5,
     session_id TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp DESC)',
  'CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type)',
  `CREATE TABLE IF NOT EXISTS assets (
     id TEXT PRIMARY KEY,
     asset_type TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT,
     sensitivity_level TEXT NOT NULL DEFAULT 'low',
     data TEXT,
     access_control TEXT,
     created_at TEXT NOT NULL,
     last_used TEXT,
     usage_count INTEGER DEFAULT 0,
     tags TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_assets_type ON assets (asset_type)',
  `CREATE TABLE IF NOT EXISTS relationships (
     id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL,
     target_id TEXT NOT NULL,
     edge_type TEXT NOT NULL,
     weight REAL DEFAULT 0.5,
     created_at TEXT NOT NULL,
     metadata TEXT,
     UNIQUE (source_id, target_id, edge_type)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships (source_id)',
  'CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships (target_id)',
  'CREATE INDEX IF NOT EXISTS idx_relationships_edge ON relationships (edge_type, weight DESC)',
  `CREATE TABLE IF NOT EXISTS changelog (
     id TEXT PRIMARY KEY,
     timestamp TEXT NOT NULL,
     operation TEXT NOT NULL,
     layer TEXT NOT NULL,
     target_id TEXT NOT NULL,
     change_details TEXT,
     reason TEXT,
     triggered_by TEXT,
     session_id TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_changelog_timestamp ON changelog (timestamp DESC)',
  'CREATE INDEX IF NOT EXISTS idx_changelog_target ON changelog (target_id)',
  'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
]

const VECTOR_TABLE = `CREATE TABLE IF NOT EXISTS memory_vectors (
  id TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

/** 版本化迁移；每条迁移在事务里执行并记录。 */
const MIGRATIONS = [
  {
    version: 1,
    description: '初始结构：memories/events/assets/relationships/changelog/config',
    upgrade(database) {
      for (const statement of BASE_TABLES) database.exec(statement)
    },
  },
  {
    version: 2,
    description: '语义索引向量表 memory_vectors',
    upgrade(database) {
      database.exec(VECTOR_TABLE)
    },
  },
]

/** 解析数据库路径。 */
export function resolveDatabasePath(ctx, settings) {
  const override = typeof settings?.storage?.dir === 'string' ? settings.storage.dir.trim() : ''
  if (override !== '') return join(override, DB_FILE)
  try {
    const homePath = ctx?.get?.('dshHomePath')
    if (typeof homePath === 'function') return homePath('storages', 'dsh-memory-plugin', DB_FILE)
  } catch {
    /* 退回环境变量 */
  }
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return join(home, 'storages', 'dsh-memory-plugin', DB_FILE)
}

/** 加载 node:sqlite。 */
export function loadSqlite() {
  const getBuiltin = process.getBuiltinModule
  if (typeof getBuiltin === 'function') {
    const mod = getBuiltin('node:sqlite')
    if (typeof mod?.DatabaseSync === 'function') return mod
    throw new Error('node:sqlite 存在但没有 DatabaseSync')
  }
  throw new Error('当前运行时没有 process.getBuiltinModule，无法加载 node:sqlite')
}

/**
 * 创建 SQLite 存储句柄。
 */
export function createSqliteStore(ctx, log, getSettings) {
  const sqlite = loadSqlite()
  const settingsOf = () => (typeof getSettings === 'function' ? getSettings() : undefined)
  let path = resolveDatabasePath(ctx, settingsOf())
  let database = null
  let statements = new Map()
  let knownItems = new Map()
  let knownAudit = []
  let vectorReady = false
  let recoveredFrom = null
  let lastError = null

  const prepare = (sql) => {
    let statement = statements.get(sql)
    if (statement === undefined) {
      statement = database.prepare(sql)
      statements.set(sql, statement)
    }
    return statement
  }
  const run = (sql, ...params) => prepare(sql).run(...params)
  const all = (sql, ...params) => prepare(sql).all(...params)

  const reset = () => {
    statements = new Map()
    knownItems = new Map()
    knownAudit = []
    vectorReady = false
  }

  const applyMigrations = (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    )`)
    const columns = db.prepare('PRAGMA table_info(schema_migrations)').all().map((row) => row.name)
    if (!columns.includes('description')) {
      try {
        db.exec("ALTER TABLE schema_migrations ADD COLUMN description TEXT NOT NULL DEFAULT ''")
      } catch {
        /* 已有 */
      }
    }
    const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version ?? 0
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      const started = Date.now()
      db.exec('BEGIN')
      try {
        migration.upgrade(db)
        db.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.description, new Date().toISOString())
        db.exec('COMMIT')
        log('info', `数据库迁移 v${migration.version} 完成（${migration.description}，${Date.now() - started}ms）`)
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 事务可能已结束 */
        }
        lastError = `迁移 v${migration.version} 失败：${message(error)}`
        log('error', lastError)
        throw error
      }
    }
  }

  const detectCapabilities = () => {
    try {
      database.prepare('SELECT count(*) FROM memory_vectors').get()
      vectorReady = true
    } catch (error) {
      vectorReady = false
      lastError = `向量表不可用：${message(error)}`
      log('warn', lastError)
    }
  }

  const openDatabase = () => {
    mkdirSync(dirname(path), { recursive: true })
    backupOnOpen(path, settingsOf()?.storage?.backupKeep ?? 3, log)
    database = new sqlite.DatabaseSync(path)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
    database.exec('PRAGMA temp_store = MEMORY')
    database.exec('PRAGMA cache_size = -32000')
    database.exec('PRAGMA mmap_size = 134217728')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    detectCapabilities()
    log('info', `SQLite 记忆库已打开：${path}`)
    return database
  }

  const ensure = () => {
    if (database !== null) return database
    if (existsSync(path)) {
      try {
        const probe = new sqlite.DatabaseSync(path, { readOnly: true })
        const result = probe.prepare('PRAGMA quick_check').get()
        probe.close()
        const verdict = result?.quick_check ?? Object.values(result ?? {})[0]
        if (String(verdict).toLowerCase() !== 'ok') throw new Error(`quick_check: ${verdict}`)
      } catch (error) {
        lastError = `数据库损坏：${message(error)}`
        log('error', lastError)
        const recovered = tryRestoreBackup(path, sqlite, log)
        if (recovered === false) throw error
        recoveredFrom = recovered
      }
    }
    return openDatabase()
  }

  const store = {
    get path() {
      return path
    },
    get dir() {
      return dirname(path)
    },
    engine: 'sqlite',
    /** 宿主 SQLite 没有 FTS5，全文索引在 search.js 的内存倒排里。 */
    get fts() {
      return false
    },
    get vectors() {
      return vectorReady
    },
    refreshPath() {
      const next = resolveDatabasePath(ctx, settingsOf())
      if (next === path) return false
      store.close()
      path = next
      reset()
      return true
    },
    info() {
      try {
        const stat = statSync(path)
        return {
          engine: 'sqlite',
          path,
          dir: dirname(path),
          exists: true,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          fts: false,
          vectors: vectorReady,
          tables: tableStats(ensure()),
          recoveredFrom,
          lastError,
        }
      } catch {
        return { engine: 'sqlite', path, dir: dirname(path), exists: false, bytes: 0, modifiedAt: null, fts: false, vectors: vectorReady, tables: null, lastError }
      }
    },
    raw() {
      return ensure()
    },
    stats() {
      const db = ensure()
      const pageSize = db.prepare('PRAGMA page_size').get()?.page_size ?? 4096
      const pageCount = db.prepare('PRAGMA page_count').get()?.page_count ?? 0
      return {
        ...tableStats(db),
        bytes: pageSize * pageCount,
        journalMode: db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? 'unknown',
        vectors: vectorReady,
      }
    },
    read() {
      const db = ensure()
      const state = readAll(db)
      if (state !== undefined) return state
      const legacy = readLegacyJson(dirname(path))
      if (legacy === undefined) return undefined
      try {
        store.write(legacy)
        log('info', `已把旧的 JSON 记忆库迁移进 SQLite：${legacy.items.length} 条`)
        return readAll(db)
      } catch (error) {
        log('warn', `迁移旧 JSON 记忆库失败：${message(error)}`)
        return legacy
      }
    },
    /** 按行签名做增量写入：新增/变更 upsert，消失的 delete；同步维护语义向量。 */
    write(state) {
      const db = ensure()
      const settings = settingsOf() ?? {}
      const wantVectors = settings.retrieval?.semantic !== false
      db.exec('BEGIN')
      try {
        writeConfig(db, 'settings', state.settings ?? {})
        writeConfig(db, 'meta', state.meta ?? {})
        writeConfig(db, 'createdAt', state.createdAt ?? new Date().toISOString())
        writeConfig(db, 'version', state.version ?? SCHEMA_VERSION)

        const items = Array.isArray(state.items) ? state.items : []
        const seen = new Set()
        for (const item of items) {
          seen.add(item.id)
          const signature = itemSignature(item)
          if (knownItems.get(item.id) === signature) continue
          upsertItem(db, item)
          if (wantVectors && vectorReady) upsertVector(db, item)
          knownItems.set(item.id, signature)
        }
        for (const id of [...knownItems.keys()]) {
          if (seen.has(id)) continue
          deleteItem(db, id)
          if (vectorReady) run('DELETE FROM memory_vectors WHERE id = ?', id)
          knownItems.delete(id)
        }
        syncRelationships(db, items)
        appendAudit(db, Array.isArray(state.audit) ? state.audit : [], knownAudit)
        knownAudit = (state.audit ?? []).map(auditSignature)
        db.exec('COMMIT')
        return new Date().toISOString()
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 事务可能已结束 */
        }
        lastError = `写入 SQLite 失败：${message(error)}`
        log('warn', lastError)
        return retryWrite(state, db, error)
      }
    },
    /** 读取一批条目的向量（缺失的跳过）。 */
    vectorsFor(ids) {
      if (!vectorReady || !Array.isArray(ids) || ids.length === 0) return []
      const db = ensure()
      const out = []
      const statement = db.prepare('SELECT id, dim, vec FROM memory_vectors WHERE id = ?')
      for (const id of ids) {
        const row = statement.get(id)
        if (row === undefined || row === null) continue
        const vector = bufferToVector(row.vec, row.dim ?? DEFAULT_DIM)
        if (vector !== null) out.push([row.id, vector])
      }
      return out
    },
    /** 重建派生索引（目前只有向量；全文索引在内存里，由引擎重建）。 */
    rebuildIndexes(items) {
      const db = ensure()
      if (!vectorReady) return { fts: false, vectors: false, items: items.length }
      db.exec('BEGIN')
      try {
        db.exec('DELETE FROM memory_vectors')
        for (const item of items) upsertVector(db, item)
        db.exec('COMMIT')
        knownItems = new Map(items.map((item) => [item.id, itemSignature(item)]))
        return { fts: false, vectors: true, items: items.length }
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 已结束 */
        }
        throw error
      }
    },
    // ---------------------------------------------------------- 高可用 --
    verify() {
      try {
        const db = ensure()
        const result = db.prepare('PRAGMA integrity_check').get()
        const verdict = result?.integrity_check ?? Object.values(result ?? {})[0]
        return { ok: String(verdict).toLowerCase() === 'ok', verdict }
      } catch (error) {
        return { ok: false, verdict: message(error) }
      }
    },
    backup(tag = 'manual') {
      const db = ensure()
      const dir = join(dirname(path), BACKUP_DIR)
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = join(dir, `backup_${stamp}_${tag}.sqlite3`)
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* 忽略 */
      }
      copyFileSync(path, target)
      pruneBackups(dir, settingsOf()?.storage?.backupKeep ?? 10)
      return { path: target, bytes: statSync(target).size, tag }
    },
    listBackups() {
      const dir = join(dirname(path), BACKUP_DIR)
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((name) => name.endsWith('.sqlite3'))
        .map((name) => {
          const full = join(dir, name)
          const stat = statSync(full)
          return { name, path: full, bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
        })
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    },
    restore(name) {
      const dir = join(dirname(path), BACKUP_DIR)
      const target = join(dir, name)
      if (!existsSync(target)) throw new Error(`备份不存在：${name}`)
      store.close()
      const corrupt = `${path}.corrupt-${Date.now()}`
      if (existsSync(path)) renameSync(path, corrupt)
      copyFileSync(target, path)
      reset()
      ensure()
      return { restored: name, previousFile: corrupt }
    },
    /** 资源上限：条目总数超过 maxItems 时，把最旧的 L6/L7 轮转记忆标为过期。 */
    enforceLimits(maxItems) {
      if (!Number.isFinite(maxItems) || maxItems <= 0) return { removed: 0 }
      const db = ensure()
      const total = db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n ?? 0
      if (total <= maxItems) return { removed: 0, total }
      const excess = total - Math.floor(maxItems * 0.9)
      const rows = db.prepare(
        `SELECT id FROM memories WHERE layer IN ('L6','L7') AND status = 'active' ORDER BY created_at ASC LIMIT ?`,
      ).all(excess)
      for (const row of rows) {
        deleteItem(db, row.id)
        if (vectorReady) run('DELETE FROM memory_vectors WHERE id = ?', row.id)
        knownItems.delete(row.id)
      }
      return { removed: rows.length, total: total - rows.length }
    },
    checkpoint() {
      try {
        ensure().exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* 忽略 */
      }
    },
    close() {
      if (database === null) return
      try {
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* 忽略 */
      }
      try {
        database.close()
      } catch {
        /* 已关闭 */
      }
      database = null
      reset()
    },
  }

  const retryWrite = (state, db, firstError) => {
    try {
      db.exec('BEGIN IMMEDIATE')
      const items = Array.isArray(state.items) ? state.items : []
      const seen = new Set(items.map((item) => item.id))
      for (const item of items) {
        upsertItem(db, item)
        if (vectorReady && (settingsOf()?.retrieval?.semantic ?? true)) upsertVector(db, item)
        knownItems.set(item.id, itemSignature(item))
      }
      for (const id of [...knownItems.keys()]) {
        if (seen.has(id)) continue
        deleteItem(db, id)
        if (vectorReady) run('DELETE FROM memory_vectors WHERE id = ?', id)
        knownItems.delete(id)
      }
      syncRelationships(db, items)
      db.exec('COMMIT')
      log('info', 'SQLite 写入在 busy 重试后成功')
      return new Date().toISOString()
    } catch (retryError) {
      lastError = `SQLite 写入重试仍失败：${message(retryError)}（首次：${message(firstError)}）`
      log('error', lastError)
      throw retryError
    }
  }

  return store
}

// ------------------------------------------------------------------ 读写实现 --

function readAll(database) {
  const configCount = database.prepare('SELECT COUNT(*) AS n FROM config').get()?.n ?? 0
  const itemCount = database.prepare(
    'SELECT (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM assets) AS n',
  ).get()?.n ?? 0
  if (configCount === 0 && itemCount === 0) return undefined

  const items = [
    ...database.prepare('SELECT * FROM memories').all().map(rowFromMemory),
    ...database.prepare('SELECT * FROM events').all().map(rowFromEvent),
    ...database.prepare('SELECT * FROM assets').all().map(rowFromAsset),
  ]
  const conflicts = new Map()
  for (const edge of database.prepare("SELECT source_id, target_id FROM relationships WHERE edge_type = 'conflict'").all()) {
    if (!conflicts.has(edge.source_id)) conflicts.set(edge.source_id, [])
    conflicts.get(edge.source_id).push(edge.target_id)
  }
  for (const item of items) {
    const related = conflicts.get(item.id) ?? []
    if (related.length > 0) item.conflicts = [...new Set([...(item.conflicts ?? []), ...related])]
  }
  const audit = database.prepare('SELECT * FROM changelog ORDER BY timestamp ASC').all().map((row) => {
    const change = parseChangeDetails(row.change_details)
    if (change !== null && typeof change === 'object' && typeof change.itemId === 'string') {
      return {
        at: row.timestamp,
        action: 'change',
        kind: 'change',
        detail: row.reason ?? '',
        actor: row.triggered_by ?? 'system',
        change,
      }
    }
    return {
      at: row.timestamp,
      action: row.operation,
      detail: row.reason ?? row.change_details ?? '',
      actor: row.triggered_by ?? 'system',
    }
  })
  return {
    version: readConfigValue(database, 'version') ?? SCHEMA_VERSION,
    createdAt: readConfigValue(database, 'createdAt') ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: readConfigValue(database, 'settings') ?? {},
    items,
    audit,
    meta: readConfigValue(database, 'meta') ?? {},
  }
}

function readConfigValue(database, key) {
  const row = database.prepare('SELECT value FROM config WHERE key = ?').get(key)
  if (row === undefined || row === null) return undefined
  try {
    return JSON.parse(row.value)
  } catch {
    return undefined
  }
}

function writeConfig(database, key, value) {
  database.prepare(
    'INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), new Date().toISOString())
}

function rowFromMemory(row) {
  let metadata = {}
  try {
    metadata = JSON.parse(row.metadata ?? '{}')
  } catch {
    metadata = {}
  }
  return {
    id: row.id,
    type: row.type,
    layer: row.layer,
    notebook: metadata.notebook ?? (row.type === 'note' ? 'memory' : null),
    title: row.title,
    content: row.content,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    importance: clampImportance((row.importance_score ?? 0.5) * 10),
    status: row.status,
    pinned: metadata.pinned === true,
    ttlDays: row.freshness_period === null || row.freshness_period === undefined ? null : Math.round(row.freshness_period / 86400),
    expiresAt: metadata.expiresAt ?? null,
    source: metadata.source ?? { kind: 'user', sessionId: null, workspace: null },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessAt: row.last_accessed ?? row.updated_at,
    accessCount: row.access_count ?? 0,
    version: metadata.version ?? 1,
    conflicts: Array.isArray(metadata.conflicts) ? metadata.conflicts : [],
    duplicateOf: metadata.duplicateOf,
  }
}

function rowFromEvent(row) {
  let payload = {}
  try {
    payload = JSON.parse(row.content ?? '{}')
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    type: 'note',
    layer: 'L5',
    notebook: 'daily',
    title: row.title ?? '',
    content: payload.content ?? row.summary ?? '',
    tags: safeJson(row.tags, []),
    importance: clampImportance((row.importance ?? 0.5) * 10),
    status: 'active',
    pinned: false,
    ttlDays: null,
    expiresAt: null,
    source: { kind: 'user', sessionId: row.session_id ?? null, workspace: null },
    createdAt: row.timestamp,
    updatedAt: row.timestamp,
    lastAccessAt: row.timestamp,
    accessCount: 0,
    version: 1,
    conflicts: [],
  }
}

function rowFromAsset(row) {
  let data = {}
  try {
    data = JSON.parse(row.data ?? '{}')
  } catch {
    data = {}
  }
  return {
    id: row.id,
    type: 'note',
    layer: 'L4',
    notebook: 'asset',
    title: row.name ?? '',
    content: row.description ?? data.content ?? '',
    tags: safeJson(row.tags, []),
    importance: clampImportance((data.importance ?? 0.5) * 10),
    status: data.status ?? 'active',
    pinned: data.pinned === true,
    ttlDays: null,
    expiresAt: null,
    source: { kind: 'user', sessionId: null, workspace: null },
    createdAt: row.created_at,
    updatedAt: data.updatedAt ?? row.created_at,
    lastAccessAt: row.last_used ?? row.created_at,
    accessCount: row.usage_count ?? 0,
    version: data.version ?? 1,
    conflicts: [],
  }
}

function upsertItem(database, item) {
  const priority = clampImportance(item.importance) / 10
  if (item.type === 'note' && item.notebook === 'daily') {
    database.prepare('DELETE FROM events WHERE id = ?').run(item.id)
    database.prepare(
      `INSERT INTO events (id, timestamp, event_type, title, summary, content, tags, participants, importance, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.createdAt ?? new Date().toISOString(),
      'daily',
      item.title ?? '',
      item.content ?? '',
      JSON.stringify({ content: item.content ?? '' }),
      JSON.stringify(item.tags ?? []),
      JSON.stringify([]),
      priority,
      item.source?.sessionId ?? null,
    )
    return
  }
  if (item.type === 'note' && item.notebook === 'asset') {
    database.prepare('DELETE FROM assets WHERE id = ?').run(item.id)
    database.prepare(
      `INSERT INTO assets (id, asset_type, name, description, sensitivity_level, data, access_control, created_at, last_used, usage_count, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      'notebook',
      item.title ?? '',
      item.content ?? '',
      'low',
      JSON.stringify({ content: item.content ?? '', importance: priority, status: item.status, updatedAt: item.updatedAt, version: item.version, pinned: item.pinned === true }),
      JSON.stringify({}),
      item.createdAt ?? new Date().toISOString(),
      item.lastAccessAt ?? null,
      item.accessCount ?? 0,
      JSON.stringify(item.tags ?? []),
    )
    return
  }
  const metadata = {
    notebook: item.notebook ?? null,
    tags: item.tags ?? [],
    pinned: item.pinned === true,
    expiresAt: item.expiresAt ?? null,
    source: item.source ?? null,
    version: item.version ?? 1,
    conflicts: item.conflicts ?? [],
    duplicateOf: item.duplicateOf,
  }
  database.prepare(
    `INSERT INTO memories (id, layer, type, title, content, metadata, created_at, updated_at, last_accessed, access_count, importance_score, confidence, freshness_period, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       layer = excluded.layer, type = excluded.type, title = excluded.title, content = excluded.content,
       metadata = excluded.metadata, updated_at = excluded.updated_at, last_accessed = excluded.last_accessed,
       access_count = excluded.access_count, importance_score = excluded.importance_score,
       freshness_period = excluded.freshness_period, status = excluded.status`,
  ).run(
    item.id,
    item.layer ?? 'L5',
    item.type ?? 'memory',
    item.title ?? '',
    item.content ?? '',
    JSON.stringify(metadata),
    item.createdAt ?? new Date().toISOString(),
    item.updatedAt ?? new Date().toISOString(),
    item.lastAccessAt ?? null,
    item.accessCount ?? 0,
    priority,
    null,
    item.ttlDays === null || item.ttlDays === undefined ? null : item.ttlDays * 86400,
    item.status ?? 'active',
  )
}

function deleteItem(database, id) {
  database.prepare('DELETE FROM memories WHERE id = ?').run(id)
  database.prepare('DELETE FROM events WHERE id = ?').run(id)
  database.prepare('DELETE FROM assets WHERE id = ?').run(id)
  database.prepare('DELETE FROM relationships WHERE source_id = ? OR target_id = ?').run(id, id)
}

/** 向量行：内容签名变化才重算。 */
function upsertVector(database, item) {
  const signature = itemSignature(item)
  const existing = database.prepare('SELECT signature FROM memory_vectors WHERE id = ?').get(item.id)
  if (existing?.signature === signature) return
  const vector = embed(ftsText(item), DEFAULT_DIM)
  database.prepare(
    `INSERT INTO memory_vectors (id, dim, vec, signature, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET vec = excluded.vec, signature = excluded.signature, updated_at = excluded.updated_at`,
  ).run(item.id, DEFAULT_DIM, vectorToBuffer(vector), signature, new Date().toISOString())
}

function syncRelationships(database, items) {
  for (const item of items) {
    const conflicts = Array.isArray(item.conflicts) ? item.conflicts : []
    database.prepare("DELETE FROM relationships WHERE source_id = ? AND edge_type = 'conflict'").run(item.id)
    for (const target of conflicts) {
      try {
        database.prepare(
          `INSERT INTO relationships (id, source_id, target_id, edge_type, weight, created_at, metadata)
           VALUES (?, ?, ?, 'conflict', 1.0, ?, '{}')`,
        ).run(randomUUID(), item.id, target, new Date().toISOString())
      } catch {
        /* 唯一约束：已有边 */
      }
    }
  }
}

function auditSignature(entry) {
  return `${entry.at}|${entry.action}|${entry.change?.itemId ?? ''}|${entry.change?.operation ?? ''}`
}

function appendAudit(database, audit, knownAudit) {
  const unchanged = audit.length >= knownAudit.length
    && knownAudit.every((entry, index) => audit[index] !== undefined && auditSignature(audit[index]) === entry)
  if (unchanged) {
    for (const entry of audit.slice(knownAudit.length)) insertAudit(database, entry)
    return
  }
  database.prepare('DELETE FROM changelog').run()
  for (const entry of audit) insertAudit(database, entry)
}

function insertAudit(database, entry) {
  const change = entry.kind === 'change' && entry.change !== null && typeof entry.change === 'object'
    ? JSON.stringify(entry.change)
    : null
  database.prepare(
    'INSERT INTO changelog (id, timestamp, operation, layer, target_id, change_details, reason, triggered_by, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    entry.at ?? new Date().toISOString(),
    entry.action ?? 'unknown',
    entry.change?.layer ?? '-',
    entry.change?.itemId ?? '-',
    change,
    entry.detail ?? '',
    entry.actor ?? 'system',
    null,
  )
}

function itemSignature(item) {
  return [
    item.updatedAt ?? '',
    item.version ?? 1,
    item.accessCount ?? 0,
    item.status ?? '',
    item.importance ?? 5,
    item.pinned === true ? 1 : 0,
    item.expiresAt ?? '',
    JSON.stringify(item.conflicts ?? []),
    JSON.stringify(item.source ?? null),
    item.title ?? '',
    (item.content ?? '').length,
  ].join('|')
}

function tableStats(database) {
  const one = (sql) => {
    try {
      return database.prepare(sql).get()?.n ?? 0
    } catch {
      return 0
    }
  }
  return {
    memories: one('SELECT COUNT(*) AS n FROM memories'),
    events: one('SELECT COUNT(*) AS n FROM events'),
    assets: one('SELECT COUNT(*) AS n FROM assets'),
    relationships: one('SELECT COUNT(*) AS n FROM relationships'),
    changelog: one('SELECT COUNT(*) AS n FROM changelog'),
    vectors: one('SELECT COUNT(*) AS n FROM memory_vectors'),
  }
}

function safeJson(text, fallback) {
  try {
    const parsed = JSON.parse(text ?? '')
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function parseChangeDetails(text) {
  if (text === null || text === undefined || text === '') return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function clampImportance(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 5
  return Math.min(10, Math.max(1, Math.round(parsed)))
}

/** 打开前把上一次的数据库留一份，保留 N 份。 */
function backupOnOpen(path, keep, log) {
  const count = Number.isFinite(keep) ? Math.max(0, Math.min(20, Math.trunc(keep))) : 0
  if (count === 0 || !existsSync(path)) return
  for (let index = count; index >= 2; index -= 1) {
    const from = `${path}.bak-${index - 1}`
    if (!existsSync(from)) continue
    try {
      copyFileSync(from, `${path}.bak-${index}`)
    } catch {
      /* 备份失败不阻塞打开 */
    }
  }
  try {
    copyFileSync(path, `${path}.bak-1`)
  } catch (error) {
    log('warn', `备份 SQLite 失败：${message(error)}`)
  }
}

/** 备份目录维护：只留最近 keep 份。 */
function pruneBackups(dir, keep) {
  const count = Number.isFinite(keep) ? Math.max(1, Math.min(50, Math.trunc(keep))) : 10
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith('.sqlite3')).sort().reverse()
    for (const file of files.slice(count)) {
      try {
        rmSync(join(dir, file))
      } catch {
        /* 删不掉就留着 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 数据库损坏时尝试从 backups/ 里最近的备份恢复（最多试 3 个）。
 * 损坏文件不会被删掉，改名成 `.corrupt-<时间戳>` 留档。
 */
function tryRestoreBackup(path, sqlite, log) {
  const dir = join(dirname(path), BACKUP_DIR)
  if (!existsSync(dir)) return false
  const files = readdirSync(dir).filter((name) => name.endsWith('.sqlite3')).sort().reverse()
  for (const file of files.slice(0, 3)) {
    try {
      const source = join(dir, file)
      const corrupt = `${path}.corrupt-${Date.now()}`
      if (existsSync(path)) renameSync(path, corrupt)
      copyFileSync(source, path)
      const probe = new sqlite.DatabaseSync(path, { readOnly: true })
      const check = probe.prepare('PRAGMA quick_check').get()
      probe.close()
      const verdict = check?.quick_check ?? Object.values(check ?? {})[0]
      if (String(verdict).toLowerCase() !== 'ok') throw new Error(`备份 ${file} 也不完整`)
      log('warn', `记忆库已从备份恢复：${file}（损坏文件：${corrupt}）`)
      return file
    } catch (error) {
      log('warn', `尝试恢复备份 ${file} 失败：${message(error)}`)
    }
  }
  return false
}

function readLegacyJson(dir) {
  const file = join(dir, LEGACY_JSON_FILE)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}
