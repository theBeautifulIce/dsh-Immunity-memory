/**
 * SQLite 存储层（设计文档 §7.1/§7.2 的落地）。
 *
 * 为什么用 `node:sqlite`：宿主进程自带它（实测 node 24.21 / electron 44.7 可用），
 * 零依赖、无 node-gyp、跨平台，插件安装时不需要编译原生模块。
 *
 * 表结构直接对齐 `docs/design/记忆插件实现设计.md` §7.2：
 *   memories      记忆主体（layer/type/content/metadata/importance/status/...）
 *   events        日常记事本（事件流水）
 *   assets        资产记事本
 *   relationships 记忆之间的关系（冲突边）
 *   changelog     记忆记事本（操作流水，即审计日志）
 *   config        运行时配置（设置 / 元信息）——设计里的“配置文件”，这里一并入库
 *
 * 与引擎的接口保持和 JSON 存储完全一致：path / dir / info() / read() / write(state) /
 * refreshPath() / close()。引擎不需要知道底下是 SQLite 还是 JSON。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { message } from './store.js'

export const DB_FILE = 'memory.sqlite3'
export const LEGACY_JSON_FILE = 'store.json'
export const SCHEMA_VERSION = 1

/** 建表 DDL：与设计文档一致；SQLite 不支持的设计字段用 TEXT 存 JSON。 */
const SCHEMA = [
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
  'CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at)',
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
  'CREATE INDEX IF NOT EXISTS idx_relationships_edge ON relationships (edge_type)',
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
  'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
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
  const home = process.env.DSH_HOME || join(homedirSafe(), '.dsh')
  return join(home, 'storages', 'dsh-memory-plugin', DB_FILE)
}

function homedirSafe() {
  try {
    return process.env.USERPROFILE || process.env.HOME || '.'
  } catch {
    return '.'
  }
}

/** 尝试加载 node:sqlite，返回 { DatabaseSync } 或抛错。 */
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
 *
 * @param ctx      Cordis 上下文（解析数据目录）。
 * @param log      `(level, text) => void`
 * @param getSettings 读取当前设置（决定目录与备份份数）。
 */
export function createSqliteStore(ctx, log, getSettings) {
  const sqlite = loadSqlite()
  const settingsOf = () => (typeof getSettings === 'function' ? getSettings() : undefined)
  let path = resolveDatabasePath(ctx, settingsOf())
  let db = null
  /** id → 签名，用于最小化写入。 */
  let knownItems = new Map()
  let knownAudit = []

  const ensure = () => {
    if (db !== null) return db
    mkdirSync(dirname(path), { recursive: true })
    backupOnce(path, settingsOf()?.storage?.backupKeep ?? 0, log)
    db = new sqlite.DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    for (const statement of SCHEMA) db.exec(statement)
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION)
    if (row === undefined || row === null) {
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, new Date().toISOString())
    }
    log('info', `SQLite 记忆库已打开：${path}`)
    return db
  }

  const readConfig = (database, key) => {
    const row = database.prepare('SELECT value FROM config WHERE key = ?').get(key)
    if (row === undefined || row === null) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return undefined
    }
  }

  const writeConfig = (database, key, value) => {
    database.prepare(
      'INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, JSON.stringify(value), new Date().toISOString())
  }

  const store = {
    get path() {
      return path
    },
    get dir() {
      return dirname(path)
    },
    engine: 'sqlite',
    /** 目录改了之后重新解析路径（下次 ensure 会重开）。 */
    refreshPath() {
      const next = resolveDatabasePath(ctx, settingsOf())
      if (next === path) return false
      store.close()
      path = next
      knownItems = new Map()
      knownAudit = []
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
          tables: tableStats(ensure()),
        }
      } catch {
        return { engine: 'sqlite', path, dir: dirname(path), exists: false, bytes: 0, modifiedAt: null, tables: null }
      }
    },
    read() {
      const database = ensure()
      const state = readAll(database)
      if (state !== undefined) return state
      // 空库：尝试从旧的 JSON 记忆库迁移一次（插件早期版本用 JSON 落盘）。
      const legacy = readLegacyJson(dirname(path))
      if (legacy === undefined) return undefined
      try {
        store.write(legacy)
        log('info', `已把旧的 JSON 记忆库迁移进 SQLite：${legacy.items.length} 条`)
        return readAll(database)
      } catch (error) {
        log('warn', `迁移旧 JSON 记忆库失败：${message(error)}`)
        return legacy
      }
    },
    /** 把整份状态按行差异写回。 */
    write(state) {
      const database = ensure()
      database.exec('BEGIN')
      try {
        writeConfig(database, 'settings', state.settings ?? {})
        writeConfig(database, 'meta', state.meta ?? {})
        writeConfig(database, 'createdAt', state.createdAt ?? new Date().toISOString())
        writeConfig(database, 'version', state.version ?? SCHEMA_VERSION)

        const items = Array.isArray(state.items) ? state.items : []
        const seen = new Set()
        for (const item of items) {
          seen.add(item.id)
          const signature = itemSignature(item)
          if (knownItems.get(item.id) === signature) continue
          upsertItem(database, item)
          knownItems.set(item.id, signature)
        }
        for (const id of [...knownItems.keys()]) {
          if (seen.has(id)) continue
          deleteItem(database, id)
          knownItems.delete(id)
        }
        syncRelationships(database, items)

        const audit = Array.isArray(state.audit) ? state.audit : []
        appendAudit(database, audit, knownAudit)
        knownAudit = audit.map((entry) => `${entry.at}|${entry.action}`)

        database.prepare('UPDATE config SET updated_at = ? WHERE key = ?').run(new Date().toISOString(), 'meta')
        database.exec('COMMIT')
        return new Date().toISOString()
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          /* 事务可能已经结束 */
        }
        log('warn', `写入 SQLite 失败：${message(error)}`)
        throw error
      }
    },
    close() {
      if (db === null) return
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
      db = null
    },
    /** 直接拿到底层连接（测试/调试用）。 */
    raw() {
      return ensure()
    },
  }
  return store
}

// ------------------------------------------------------------------ 读写实现 --

function readAll(database) {
  const configCount = database.prepare('SELECT COUNT(*) AS n FROM config').get()
  const itemCount = database.prepare('SELECT (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM assets) AS n').get()
  if ((configCount?.n ?? 0) === 0 && (itemCount?.n ?? 0) === 0) return undefined

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
  const audit = database.prepare('SELECT * FROM changelog ORDER BY timestamp ASC').all()
    .map((row) => ({
      at: row.timestamp,
      action: row.operation,
      detail: row.reason ?? row.change_details ?? '',
      actor: row.triggered_by ?? 'system',
    }))
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
  const tags = safeJson(row.tags, [])
  return {
    id: row.id,
    type: 'note',
    layer: 'L5',
    notebook: 'daily',
    title: row.title ?? '',
    content: payload.content ?? row.summary ?? '',
    tags,
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
      JSON.stringify({ content: item.content ?? '', importance: priority, status: item.status, updatedAt: item.updatedAt, version: item.version }),
      JSON.stringify({}),
      item.createdAt ?? new Date().toISOString(),
      item.lastAccessAt ?? null,
      item.accessCount ?? 0,
      JSON.stringify(item.tags ?? []),
    )
    return
  }
  // 其余（普通记忆、记忆记事本条目）都落在 memories。
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

/** 冲突边按 source 全量刷新，保证关系表与条目一致。 */
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
        // 撞上已有边（唯一约束）就跳过
      }
    }
  }
}

/** 审计日志只追加；被截断（compact）时整表重写。 */
function appendAudit(database, audit, knownAudit) {
  const unchanged = audit.length >= knownAudit.length
    && knownAudit.every((entry, index) => audit[index] !== undefined && `${audit[index].at}|${audit[index].action}` === entry)
  if (unchanged) {
    for (const entry of audit.slice(knownAudit.length)) insertAudit(database, entry)
    return
  }
  database.prepare('DELETE FROM changelog').run()
  for (const entry of audit) insertAudit(database, entry)
}

function insertAudit(database, entry) {
  database.prepare(
    'INSERT INTO changelog (id, timestamp, operation, layer, target_id, change_details, reason, triggered_by, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    entry.at ?? new Date().toISOString(),
    entry.action ?? 'unknown',
    '-',
    '-',
    null,
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
  ].join('|')
}

function tableStats(database) {
  const one = (sql) => database.prepare(sql).get()?.n ?? 0
  return {
    memories: one('SELECT COUNT(*) AS n FROM memories'),
    events: one('SELECT COUNT(*) AS n FROM events'),
    assets: one('SELECT COUNT(*) AS n FROM assets'),
    relationships: one('SELECT COUNT(*) AS n FROM relationships'),
    changelog: one('SELECT COUNT(*) AS n FROM changelog'),
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

function clampImportance(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 5
  return Math.min(10, Math.max(1, Math.round(parsed)))
}

/** 打开前把上一次的数据库留一份，保留 N 份。 */
function backupOnce(path, keep, log) {
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

/** 读取旧版插件的 store.json（没有就返回 undefined）。 */
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
