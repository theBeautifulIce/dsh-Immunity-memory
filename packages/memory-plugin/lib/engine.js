/**
 * 记忆引擎：八层记忆 + 记事本 + 混合检索 + 反思维护。
 *
 * 职责边界：
 *   - 本文件负责业务规则（分层权限、去重、冲突、维护流程、统计、导入导出）；
 *   - 检索细节交给 lib/search.js（FTS5 + 倒排 + 语义 + 图谱 + 融合）；
 *   - 持久化交给 lib/sqlite.js 或 lib/store.js；
 *   - 批量数学交给 lib/native.js（Rust 原生核心，缺失时 JS 兜底）。
 *
 * 分层语义（来自设计文档）：
 *   L0 灵魂层 / L1 思想核心 / L3 本能行为 —— 不可变，默认只读；
 *   L2 思想流动 —— 可变且需要冲突检测；
 *   L4 学习行为 / L5 目标记忆 —— 可变；
 *   L6 轮转记忆 / L7 情境感知 —— 有保鲜期，过期自动清理。
 */
import { randomUUID } from 'node:crypto'
import {
  LAYERS,
  LAYER_IDS,
  NOTEBOOK_IDS,
  clone,
  getPath,
  layerEnabled,
  layerInfo,
  normalizeSettings,
} from './settings.js'
import { emptyState, message, STORE_VERSION } from './store.js'
import { createSearchEngine } from './search.js'
import { fallbackCosineBatch, fallbackDedupe, fallbackImportance } from './fallback-math.js'
import { jaccard, tokenize } from './text.js'

export { jaccard, tokenize }

export const ITEM_TYPES = ['memory', 'note']
export const ITEM_STATUSES = ['active', 'archived', 'expired', 'conflicted']
const MAX_TITLE = 240
const MAX_TAGS = 24
const MAX_TAG_LENGTH = 48
const MAX_CONTENT = 200000
const DEDUPE_SCAN_LIMIT = 1200

const STATUS_WEIGHT = { active: 1, conflicted: 0.85, archived: 0.6, expired: 0.4 }

/** 新建一条记忆/记事本条目。 */
export async function createEngine({ store, getSettings, initialSettings, log, native }) {
  let state
  /** id → item 的索引，检索时避免每次重建 Map。 */
  let itemMap = new Map()

  // 设置归属：存档里有就以存档为准（用户在设置页改的），否则用行配置里的初始值。
  const fallbackSettings = () => normalizeSettings(initialSettings ?? getSettings?.() ?? {})
  const settings = () => normalizeSettings(state?.settings ?? fallbackSettings())

  // 检索层：FTS5 / 倒排 + 语义 + 图谱 + 融合
  // 原生核心缺失时用纯 JS 兜底：功能一致，只是批量计算慢一些。
  const nativeCore = native ?? {
    cosine: async (query, matrix, count, dim) => fallbackCosineBatch(query, matrix, count, dim),
    importance: async (items, now) => fallbackImportance(items, now),
    dedupe: async (items, threshold) => fallbackDedupe(items, threshold),
    similar: async () => [],
    health: () => ({ available: false, fallback: true, reason: 'native core not provided' }),
  }
  const searchEngine = createSearchEngine({ store, native: nativeCore, getSettings: settings, log })
  const reindexAll = () => {
    itemMap = new Map((state?.items ?? []).map((item) => [item.id, item]))
    searchEngine.rebuild(state?.items ?? [])
  }
  const indexItem = (item) => {
    if (item === undefined) return
    itemMap.set(item.id, item)
    searchEngine.upsert(item)
  }
  const unindexItem = (id) => {
    itemMap.delete(id)
    searchEngine.remove(id)
  }

  /** 读取并修复磁盘上的状态。 */
  function hydrate(raw) {
    const base = emptyState(settings())
    if (raw === null || typeof raw !== 'object') return base
    const next = {
      version: STORE_VERSION,
      createdAt: isoOr(raw.createdAt, base.createdAt),
      updatedAt: isoOr(raw.updatedAt, base.updatedAt),
      settings: normalizeSettings(raw.settings ?? initialSettings ?? {}),
      items: [],
      audit: [],
      meta: { ...base.meta, ...(raw.meta !== null && typeof raw.meta === 'object' ? raw.meta : {}) },
    }
    const items = Array.isArray(raw.items) ? raw.items : []
    const seen = new Set()
    for (const candidate of items) {
      const item = normalizeItem(candidate)
      if (item === undefined) continue
      if (seen.has(item.id)) item.id = newId()
      seen.add(item.id)
      next.items.push(item)
    }
    const audit = Array.isArray(raw.audit) ? raw.audit : []
    next.audit = audit
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.action === 'string')
      .slice(-5000)
      .map((entry) => ({
        at: isoOr(entry.at, new Date(0).toISOString()),
        action: String(entry.action).slice(0, 60),
        detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 400) : '',
        actor: typeof entry.actor === 'string' ? entry.actor.slice(0, 40) : 'system',
      }))
    return next
  }

  // 远程存储（Go 服务）走 load/apply；本地回退走 read/write。
  const remote = typeof store.load === 'function' && typeof store.apply === 'function'

  /** 首次加载：远程存储是异步的（HTTP 到 Go 服务）。 */
  async function ensureLoaded() {
    if (state === undefined) {
      const raw = remote ? await store.load() : store.read()
      state = hydrate(raw)
      reindexAll()
    }
    return state
  }

  /** 同步读取已经加载好的状态（工厂里会先 ensureLoaded）。 */
  function currentState() {
    if (state === undefined) throw createError('NOT_READY', '记忆库尚未加载')
    return state
  }

  /** 落盘：远程存储按行签名增量同步，本地存储整体写入。 */
  async function persist() {
    const current = currentState()
    current.updatedAt = new Date().toISOString()
    if (remote) return store.apply(current)
    return store.write(current)
  }

  // 访问计数是启发式数据：按 1.5s 合并落盘，避免每次检索都写一次库。
  let accessDirty = false
  let accessTimer = null
  function scheduleAccessPersist() {
    accessDirty = true
    if (accessTimer !== null) return
    accessTimer = setTimeout(() => {
      accessTimer = null
      flushAccess().catch((error) => log('warn', `访问计数落盘失败：${message(error)}`))
    }, 1500)
    accessTimer.unref?.()
  }
  async function flushAccess() {
    if (!accessDirty) return
    accessDirty = false
    try {
      await persist()
    } catch (error) {
      accessDirty = true
      throw error
    }
  }

  function audit(action, detail, actor = 'system') {
    const current = currentState()
    const keep = settings().maintenance.auditKeep
    if (!settings().privacy.auditLog || keep <= 0) {
      current.audit = []
      return
    }
    current.audit.push({ at: new Date().toISOString(), action, detail: truncate(detail, 400), actor })
    if (current.audit.length > keep) current.audit = current.audit.slice(-keep)
  }

  // ---------------------------------------------------------------- 读取 ----

  function listItems(options = {}) {
    const current = currentState()
    const active = settings()
    const pageSize = clampInt(options.limit, 1, active.retrieval.maxLimit, active.ui.pageSize)
    const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0)
    const filtered = filterItems(current.items, options, active)
    const sorted = sortItems(filtered, options.sort ?? 'updated')
    return {
      items: sorted.slice(offset, offset + pageSize).map(decorate),
      total: sorted.length,
      offset,
      limit: pageSize,
      stats: summarize(current, active),
    }
  }

  /**
   * 混合检索（async：语义重排要等原生核心批量余弦）。
   * 返回结构兼容旧版调用方：items 里带 score，同时新增 breakdown 便于调试。
   */
  async function searchItems(options = {}) {
    const current = await ensureLoaded()
    const active = settings()
    const query = typeof options.query === 'string' ? options.query.trim() : ''
    const limit = clampInt(options.limit, 1, active.retrieval.maxLimit, active.retrieval.defaultLimit)
    const status = options.status ?? 'usable'
    const started = Date.now()

    if (query === '') {
      // 空查询=按重要度/时间列一批，不需要经过索引
      const scope = filterItems(current.items, { ...options, status }, active)
      const sorted = sortItems(scope, options.sort ?? 'updated').slice(0, limit)
      for (const item of sorted) {
        item.accessCount = (item.accessCount ?? 0) + 1
        item.lastAccessAt = new Date().toISOString()
      }
      if (sorted.length > 0) scheduleAccessPersist()
      current.meta.searches = (current.meta.searches ?? 0) + 1
      return {
        items: sorted.map((item) => ({ ...decorate(item), score: round(scoreItem(item, new Set(), active, Date.now())) })),
        total: scope.length,
        query,
        limit,
        tokens: 0,
        tookMs: Date.now() - started,
        breakdown: 'listing',
      }
    }

    // 1) 有 Go 服务时：FTS5 + 语义 + 图谱 + 融合全部由 Go 完成
    if (remote && typeof store.search === 'function') {
      const result = await store.search({
        query,
        limit,
        layer: options.layer,
        type: options.type,
        notebook: options.notebook,
        tags: options.tags,
        status,
        weights: active.retrieval.weights,
        semantic: active.retrieval.semantic !== false,
        graph: active.retrieval.graph !== false,
        graphDepth: active.retrieval.graphDepth,
        graphSeeds: active.retrieval.graphSeeds,
        graphMinWeight: active.retrieval.graphMinWeight,
      })
      const hits = []
      for (const hit of result.hits ?? []) {
        const item = itemMap.get(hit.id)
        if (item === undefined) continue
        item.accessCount = (item.accessCount ?? 0) + 1
        item.lastAccessAt = new Date().toISOString()
        hits.push({ ...decorate(item), score: round(hit.score), breakdown: hit.breakdown })
      }
      if (hits.length > 0) scheduleAccessPersist()
      current.meta.searches = (current.meta.searches ?? 0) + 1
      return {
        items: hits,
        total: result.total ?? hits.length,
        query,
        limit,
        tokens: tokenize(query).size,
        tookMs: Date.now() - started,
        weights: result.weights,
        cached: false,
        breakdown: 'go',
      }
    }

    // 2) 回退：Node 内置倒排 + 语义 + 图谱
    const result = await searchEngine.search({
      items: itemMap,
      query,
      limit,
      layer: options.layer,
      type: options.type,
      notebook: options.notebook,
      tags: options.tags,
      status,
    })
    // 命中即"被想起"：累计访问次数，供"记忆提升"使用。
    const hits = []
    for (const hit of result.items) {
      const item = itemMap.get(hit.item.id)
      if (item === undefined) continue
      item.accessCount = (item.accessCount ?? 0) + 1
      item.lastAccessAt = new Date().toISOString()
      hits.push({ ...decorate(item), score: round(hit.score), breakdown: hit.breakdown })
    }
    if (hits.length > 0) scheduleAccessPersist()
    current.meta.searches = (current.meta.searches ?? 0) + 1
    return {
      items: hits,
      total: result.total,
      query,
      limit,
      tokens: tokenize(query).size,
      tookMs: Date.now() - started,
      weights: result.weights,
      cached: result.cached === true,
      breakdown: 'hybrid',
    }
  }

  function getItem(id) {
    const item = currentState().items.find((candidate) => candidate.id === id)
    return item === undefined ? undefined : decorate(item)
  }

  // ---------------------------------------------------------------- 写入 ----

  async function createItem(input = {}, actor = 'user') {
    const current = await ensureLoaded()
    const active = settings()
    assertEnabled(active)
    const layer = normalizeLayer(input.layer ?? active.write.defaultLayer)
    assertLayerWritable(active, layer)
    const type = input.type === 'note' ? 'note' : 'memory'
    const notebook = type === 'note' ? normalizeNotebook(input.notebook) : null
    const title = truncate(String(input.title ?? '').trim(), MAX_TITLE) || deriveTitle(input.content, type)
    const content = truncate(String(input.content ?? ''), MAX_CONTENT)
    if (type === 'memory' && content.trim().length < active.write.minContentLength) {
      throw createError('TOO_SHORT', `正文至少需要 ${active.write.minContentLength} 个字符`)
    }
    if (title === '' && content.trim() === '') throw createError('EMPTY', '标题和正文不能同时为空')
    const now = new Date().toISOString()
    const item = normalizeItem({
      id: newId(),
      type,
      layer,
      notebook,
      title,
      content,
      tags: normalizeTags(input.tags),
      importance: clampInt(input.importance, 1, 10, active.write.defaultImportance),
      status: 'active',
      pinned: input.pinned === true,
      ttlDays: type === 'memory' ? normalizeTtl(input.ttlDays, active, layer) : null,
      source: {
        kind: actor === 'agent' ? 'agent' : actor === 'import' ? 'import' : 'user',
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
        workspace: typeof input.workspace === 'string' ? input.workspace : null,
      },
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      accessCount: 0,
    })
    if (item === undefined) throw createError('INVALID', '无法创建条目')

    const duplicate = findSimilar(current.items, item, active.write.dedupeThreshold)
    if (duplicate !== undefined) item.duplicateOf = duplicate.id
    // 保鲜期：L6/L7 默认层或显式 ttlDays 的条目到期后由清理任务归档。
    item.expiresAt = expiresAtFor(item, active)
    current.items.push(item)
    indexItem(item)
    detectConflicts(current, item, active)
    audit('create', `${item.layer}/${item.type} ${item.title}`, actor)
    current.meta.writes = (current.meta.writes ?? 0) + 1
    await persist()
    return decorate(item)
  }

  async function updateItem(id, patch = {}, actor = 'user') {
    const current = await ensureLoaded()
    const active = settings()
    const index = current.items.findIndex((candidate) => candidate.id === id)
    if (index < 0) throw createError('NOT_FOUND', `找不到条目 ${id}`)
    const before = current.items[index]
    assertLayerWritable(active, before.layer)
    const next = { ...before }
    if (patch.title !== undefined) next.title = truncate(String(patch.title).trim(), MAX_TITLE) || before.title
    if (patch.content !== undefined) next.content = truncate(String(patch.content), MAX_CONTENT)
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags)
    if (patch.importance !== undefined) next.importance = clampInt(patch.importance, 1, 10, before.importance)
    if (patch.layer !== undefined) {
      const layer = normalizeLayer(patch.layer)
      assertLayerWritable(active, layer)
      next.layer = layer
    }
    if (patch.notebook !== undefined && next.type === 'note') next.notebook = normalizeNotebook(patch.notebook)
    if (patch.pinned !== undefined) next.pinned = patch.pinned === true
    if (patch.status !== undefined) {
      if (!ITEM_STATUSES.includes(patch.status)) throw createError('INVALID_STATUS', `未知状态 ${patch.status}`)
      next.status = patch.status
    }
    if (patch.ttlDays !== undefined) next.ttlDays = normalizeTtl(patch.ttlDays, active, next.layer)
    if (patch.title === undefined && patch.content === undefined && patch.tags === undefined
      && patch.importance === undefined && patch.layer === undefined && patch.pinned === undefined
      && patch.status === undefined && patch.ttlDays === undefined && patch.notebook === undefined) {
      return decorate(before)
    }
    next.updatedAt = new Date().toISOString()
    next.version = (before.version ?? 1) + 1
    next.expiresAt = expiresAtFor(next, active)
    current.items[index] = normalizeItem(next) ?? before
    indexItem(current.items[index])
    detectConflicts(current, current.items[index], active)
    audit('update', `${current.items[index].layer}/${current.items[index].title}`, actor)
    await persist()
    return decorate(current.items[index])
  }

  async function deleteItems(ids, actor = 'user') {
    const current = await ensureLoaded()
    const active = settings()
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string'))
    if (wanted.size === 0) return { deleted: 0 }
    const removed = []
    current.items = current.items.filter((item) => {
      if (!wanted.has(item.id)) return true
      if (layerInfo(item.layer).immutable && !active.write.allowImmutableEdit) {
        log('warn', `拒绝删除不可变分层的条目 ${item.id}（${item.layer}）`)
        return true
      }
      removed.push(item.id)
      return false
    })
    for (const item of current.items) {
      item.conflicts = item.conflicts.filter((other) => !removed.includes(other))
      if (item.conflicts.length === 0 && item.status === 'conflicted') item.status = 'active'
    }
    if (removed.length > 0) {
      for (const id of removed) unindexItem(id)
      audit('delete', `删除 ${removed.length} 条：${removed.slice(0, 5).join(', ')}`, actor)
      await persist()
    }
    return { deleted: removed.length, ids: removed }
  }

  /** 批量操作：归档 / 恢复 / 置顶 / 取消置顶 / 提升 / 降低。 */
  async function bulkAction(ids, action, actor = 'user') {
    const current = await ensureLoaded()
    const active = settings()
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string'))
    if (wanted.size === 0) throw createError('NO_IDS', '至少选择一条')
    if (action === 'delete') return deleteItems([...wanted], actor)
    const allowed = ['archive', 'restore', 'pin', 'unpin', 'promote', 'demote']
    if (!allowed.includes(action)) throw createError('INVALID_ACTION', `未知操作 ${action}`)
    let changed = 0
    for (const item of current.items) {
      if (!wanted.has(item.id)) continue
      if (layerInfo(item.layer).immutable && !active.write.allowImmutableEdit) continue
      if (action === 'archive' && item.status !== 'archived') {
        item.status = 'archived'
        changed += 1
      } else if (action === 'restore' && item.status !== 'active') {
        item.status = 'active'
        changed += 1
      } else if (action === 'pin' && !item.pinned) {
        item.pinned = true
        changed += 1
      } else if (action === 'unpin' && item.pinned) {
        item.pinned = false
        changed += 1
      } else if (action === 'promote') {
        const next = Math.min(10, (item.importance ?? 5) + 1)
        if (next !== item.importance) {
          item.importance = next
          changed += 1
        }
      } else if (action === 'demote') {
        const next = Math.max(1, (item.importance ?? 5) - 1)
        if (next !== item.importance) {
          item.importance = next
          changed += 1
        }
      }
      if (changed > 0) {
        item.updatedAt = new Date().toISOString()
        item.version = (item.version ?? 1) + 1
      }
    }
    if (changed > 0) {
      reindexAll()
      audit(action, `${action} ${changed} 条`, actor)
      await persist()
    }
    return { action, changed }
  }

  // ------------------------------------------------------------ 维护任务 ----

  /**
   * 维护任务（async：去重与重要性评分走原生核心批量计算）。
   *
   * 任务：
   *   cleanup  过期清理（按 expiresAt）
   *   rotate   轮转清理（按原生重要性评分，L6/L7 低分条目过期）
   *   archive  归档（长期未更新且重要度低）
   *   dedupe   去重/冲突（LSH 候选 + 精确 Jaccard，原生核心批量算）
   *   reflect  反思提升（访问次数 + 重要性评分给出建议或自动提升）
   *   compact  压缩审计日志
   *   limits   资源上限（条目过多时删最旧的轮转记忆）
   */
  async function runMaintenance(options = {}) {
    const current = await ensureLoaded()
    const active = settings()
    const now = Date.now()
    const wanted = Array.isArray(options.tasks) && options.tasks.length > 0
      ? options.tasks.filter((task) => typeof task === 'string')
      : ['cleanup', 'rotate', 'archive', 'dedupe', 'reflect']
    const report = { ranAt: new Date().toISOString(), tasks: [], totals: {} }
    let dirty = false

    for (const task of wanted) {
      if (task === 'cleanup') {
        let expired = 0
        for (const item of current.items) {
          if (item.status === 'expired' || item.pinned) continue
          if (item.expiresAt === null) continue
          if (Date.parse(item.expiresAt) > now) continue
          item.status = 'expired'
          expired += 1
        }
        if (expired > 0) {
          dirty = true
          await persist()
        }
        current.meta.lastCleanup = new Date().toISOString()
        report.tasks.push({ task, changed: expired, note: `过期 ${expired} 条` })
      } else if (task === 'rotate') {
        const threshold = clampNumber(active.maintenance.rotateMinImportance, 0, 1, 0.3)
        const candidates = current.items.filter(
          (item) => (item.layer === 'L6' || item.layer === 'L7') && item.status === 'active' && !item.pinned,
        )
        let rotated = 0
        if (candidates.length > 0) {
          const scores = await nativeCore.importance(candidates.map(toImportanceInput), now / 1000)
          candidates.forEach((item, index) => {
            if ((scores[index] ?? 1) < threshold) {
              item.status = 'expired'
              rotated += 1
            }
          })
        }
        if (rotated > 0) {
          dirty = true
          await persist()
        }
        current.meta.lastRotate = new Date().toISOString()
        report.tasks.push({ task, changed: rotated, note: `轮转清理 ${rotated} 条（重要性 < ${threshold}）` })
      } else if (task === 'archive') {
        const days = Math.max(1, active.maintenance.archiveAfterDays)
        let archived = 0
        for (const item of current.items) {
          if (item.status !== 'active' || item.pinned) continue
          if (item.importance > 4) continue
          const age = (now - Date.parse(item.updatedAt)) / 86400000
          if (age < days) continue
          item.status = 'archived'
          archived += 1
        }
        if (archived > 0) {
          dirty = true
          await persist()
        }
        report.tasks.push({ task, changed: archived, note: `归档 ${archived} 条（>${days} 天未更新且重要度≤4）` })
      } else if (task === 'dedupe') {
        const result = await dedupeAll(current, active)
        if (result.changed > 0) {
          dirty = true
          await persist()
        }
        report.tasks.push({ task, changed: result.changed, note: `标记 ${result.changed} 组疑似重复（扫描 ${result.scanned} 条）` })
      } else if (task === 'reflect') {
        const result = await reflect(current, active, now)
        if (result.changed > 0) {
          dirty = true
          await persist()
        }
        current.meta.lastReflect = new Date().toISOString()
        report.tasks.push({ task, changed: result.changed, note: result.note, suggestions: result.suggestions })
      } else if (task === 'compact') {
        const keep = Math.max(0, active.maintenance.auditKeep)
        const before = current.audit.length
        current.audit = keep === 0 ? [] : current.audit.slice(-keep)
        report.tasks.push({ task, changed: before - current.audit.length, note: `清理审计日志 ${before - current.audit.length} 条` })
        await persist()
      } else if (task === 'limits') {
        const maxItems = clampInt(active.maintenance.maxItems, 100, 1_000_000, 100_000)
        let removed = 0
        if (current.items.length > maxItems) {
          const excess = current.items.length - Math.floor(maxItems * 0.9)
          const oldest = current.items
            .filter((item) => (item.layer === 'L6' || item.layer === 'L7') && !item.pinned && item.status === 'active')
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .slice(0, excess)
          for (const item of oldest) {
            item.status = 'expired'
            removed += 1
          }
          if (removed > 0) {
            dirty = true
            await persist()
          }
        }
        report.tasks.push({ task, changed: removed, note: `资源上限：共 ${current.items.length} 条，上限 ${maxItems}，处理 ${removed} 条` })
      } else {
        report.tasks.push({ task, changed: 0, note: '未知任务，已跳过' })
      }
    }

    if (dirty) reindexAll()
    report.totals = summarize(current, active)
    current.meta.lastMaintenance = report.ranAt
    audit('maintenance', wanted.join(','), 'system')
    await persist()
    return report
  }

  /** 找出与给定条目高度相似的候选。 */
  function findSimilar(items, item, threshold) {
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return undefined
    const tokens = tokenize(`${item.title} ${item.content}`)
    if (tokens.size === 0) return undefined
    let best
    let bestScore = 0
    for (const candidate of items) {
      if (candidate.id === item.id) continue
      if (candidate.type !== item.type) continue
      const score = jaccard(tokens, tokenize(`${candidate.title} ${candidate.content}`))
      if (score >= threshold && score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    return best
  }

  function detectConflicts(current, item, active) {
    if (!layerInfo(item.layer).conflictable) return 0
    const threshold = active.maintenance.conflictThreshold
    const tokens = tokenize(`${item.title} ${item.content}`)
    if (tokens.size === 0) return 0
    let marked = 0
    for (const other of current.items) {
      if (other.id === item.id || other.layer !== item.layer) continue
      const score = jaccard(tokens, tokenize(`${other.title} ${other.content}`))
      if (score < threshold) continue
      if (!item.conflicts.includes(other.id)) item.conflicts.push(other.id)
      if (!other.conflicts.includes(item.id)) other.conflicts.push(item.id)
      if (item.status === 'active') item.status = 'conflicted'
      if (other.status === 'active') other.status = 'conflicted'
      marked += 1
    }
    return marked
  }

  /**
   * 去重/冲突检测：把候选条目交给原生核心做 LSH 候选 + 精确 Jaccard，
   * 再按设计文档的规则写回条目（L2 置 conflicted，其它层只标 duplicateOf）。
   */
  async function dedupeAll(current, active) {
    const threshold = active.maintenance.conflictThreshold
    const scan = current.items
      .filter((item) => item.status !== 'expired')
      .slice(0, DEDUPE_SCAN_LIMIT)
    if (scan.length < 2) return { changed: 0, scanned: scan.length }
    const payload = scan.map((item) => ({
      id: item.id,
      tokens: [...tokenize(`${item.title} ${item.content}`)],
    }))
    const pairs = await nativeCore.dedupe(payload, threshold)
    const byId = new Map(scan.map((item) => [item.id, item]))
    let changed = 0
    for (const pair of pairs) {
      const left = byId.get(pair.a)
      const right = byId.get(pair.b)
      if (left === undefined || right === undefined) continue
      if (left.type !== right.type) continue
      if (layerInfo(left.layer).conflictable && layerInfo(right.layer).conflictable) {
        if (!left.conflicts.includes(right.id)) left.conflicts.push(right.id)
        if (!right.conflicts.includes(left.id)) right.conflicts.push(left.id)
        if (left.status === 'active') left.status = 'conflicted'
        if (right.status === 'active') right.status = 'conflicted'
        changed += 1
      } else {
        // 非冲突层：只记录"疑似重复"，不动状态
        if (left.duplicateOf === undefined) left.duplicateOf = right.id
        if (right.duplicateOf === undefined) right.duplicateOf = left.id
        changed += 1
      }
    }
    return { changed, scanned: scan.length, pairs: pairs.length }
  }

  /** 反思提升：原生重要性评分 + 访问次数，给出建议或自动提升。 */
  async function reflect(current, active, now) {
    const need = Math.max(1, active.maintenance.promoteAccessCount)
    const candidates = current.items.filter((item) => item.status === 'active')
    if (candidates.length === 0) return { changed: 0, note: '没有可反思的条目', suggestions: [] }
    const scores = await nativeCore.importance(candidates.map(toImportanceInput), now / 1000)
    const suggestions = []
    let changed = 0
    candidates.forEach((item, index) => {
      const score = scores[index] ?? 0
      if ((item.accessCount ?? 0) < need && score < 0.7) return
      if (item.importance >= 10) return
      suggestions.push({
        id: item.id,
        title: item.title,
        layer: item.layer,
        accessCount: item.accessCount,
        importance: item.importance,
        score: round(score),
      })
      if (active.maintenance.autoPromote) {
        item.importance = Math.min(10, item.importance + 1)
        item.updatedAt = new Date().toISOString()
        changed += 1
      }
    })
    suggestions.sort((left, right) => right.score - left.score)
    return {
      changed,
      note: active.maintenance.autoPromote
        ? `自动提升 ${changed} 条记忆的重要度`
        : `发现 ${suggestions.length} 条值得提升的记忆（自动提升已关闭）`,
      suggestions: suggestions.slice(0, 20),
    }
  }

  // ------------------------------------------------------------ 统计 / 导出 --

  function summarize(current, active) {
    const byLayer = Object.fromEntries(LAYER_IDS.map((id) => [id, 0]))
    const byType = { memory: 0, note: 0 }
    const byStatus = { active: 0, archived: 0, expired: 0, conflicted: 0 }
    const byNotebook = Object.fromEntries(NOTEBOOK_IDS.map((id) => [id, 0]))
    let importanceSum = 0
    let newest = null
    let oldest = null
    for (const item of current.items) {
      byLayer[item.layer] = (byLayer[item.layer] ?? 0) + 1
      byType[item.type] = (byType[item.type] ?? 0) + 1
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
      if (item.type === 'note' && item.notebook !== null) byNotebook[item.notebook] = (byNotebook[item.notebook] ?? 0) + 1
      importanceSum += item.importance
      if (newest === null || item.updatedAt > newest) newest = item.updatedAt
      if (oldest === null || item.createdAt < oldest) oldest = item.createdAt
    }
    const total = current.items.length
    return {
      total,
      memories: byType.memory,
      notes: byType.note,
      byLayer,
      byStatus,
      byNotebook,
      averageImportance: total === 0 ? 0 : round(importanceSum / total),
      newest,
      oldest,
      writes: current.meta.writes ?? 0,
      searches: current.meta.searches ?? 0,
      enabledLayers: LAYER_IDS.filter((id) => layerEnabled(active, id)),
      lastMaintenance: current.meta.lastMaintenance ?? null,
    }
  }

  function status() {
    const current = currentState()
    const active = settings()
    return {
      version: STORE_VERSION,
      pluginVersion: '0.1.0',
      enabled: active.enabled,
      storage: store.info(),
      stats: summarize(current, active),
      search: searchEngine.stats(),
      native: typeof nativeCore.health === 'function' ? nativeCore.health() : { available: false },
      layers: LAYERS,
      notebooks: NOTEBOOK_LIST,
      toolNames: TOOL_NAMES,
      updatedAt: current.updatedAt,
    }
  }

  function exportData() {
    const current = currentState()
    return {
      format: 'dsh-memory-plugin',
      version: STORE_VERSION,
      exportedAt: new Date().toISOString(),
      settings: clone(settings()),
      items: clone(current.items),
      meta: clone(current.meta),
    }
  }

  async function importData(payload, mode = 'merge') {
    const current = await ensureLoaded()
    const active = settings()
    const incoming = Array.isArray(payload?.items) ? payload.items : []
    if (incoming.length === 0) throw createError('EMPTY_IMPORT', '导入内容里没有 items')
    const imported = []
    let skipped = 0
    const existingIds = new Set(current.items.map((item) => item.id))
    for (const candidate of incoming) {
      const normalized = normalizeItem(candidate)
      if (normalized === undefined) {
        skipped += 1
        continue
      }
      if (mode !== 'replace' && existingIds.has(normalized.id)) normalized.id = newId()
      existingIds.add(normalized.id)
      normalized.source = { ...normalized.source, kind: 'import' }
      imported.push(normalized)
    }
    if (mode === 'replace') {
      const keep = current.items.filter((item) => layerInfo(item.layer).immutable && !active.write.allowImmutableEdit)
      const replaced = new Map(keep.map((item) => [item.id, item]))
      for (const item of imported) replaced.set(item.id, item)
      current.items = [...replaced.values()]
    } else {
      current.items = [...current.items, ...imported]
      reindexAll()
    }
    if (payload?.settings !== undefined && mode === 'replace') current.settings = normalizeSettings(payload.settings)
    audit('import', `导入 ${imported.length} 条（跳过 ${skipped}）`, 'user')
    await persist()
    return { imported: imported.length, skipped, mode }
  }

  /** 提示词注入用的摘要文本。 */
  function promptDigest(now = Date.now()) {
    const current = currentState()
    const active = settings()
    if (!active.enabled || !active.prompt.inject || active.prompt.topN <= 0) return ''
    const candidates = current.items.filter((item) => {
      if (item.status !== 'active' && item.status !== 'conflicted') return false
      if (!layerEnabled(active, item.layer)) return false
      if (item.type !== 'memory') return false
      return true
    })
    const scored = candidates.map((item) => ({ item, score: scoreItem(item, new Set(), active, now) }))
    scored.sort((left, right) => right.score - left.score)
    const chosen = scored.slice(0, active.prompt.topN)
    if (chosen.length === 0) return ''
    const lines = chosen.map(({ item }) => {
      const body = truncate(item.content.replace(/\s+/g, ' ').trim(), 220)
      return `- [${item.layer}·重要度${item.importance}] ${item.title}：${body}`
    })
    const header = [
      '## 长期记忆（dsh-memory-plugin）',
      '下面是从跨会话记忆里挑出的、可能相关的条目。只在确实相关时使用，不要臆造未列出的记忆。',
      '需要更多细节时用 memory_search 检索；新的关键事实用 memory_write 保存。',
    ].join('\n')
    let text = `${header}\n${lines.join('\n')}`
    if (active.prompt.maxChars > 0 && text.length > active.prompt.maxChars) {
      text = `${text.slice(0, Math.max(0, active.prompt.maxChars - 1))}…`
    }
    return text
  }

  const api = {
    // 读取
    status,
    listItems,
    searchItems,
    getItem,
    stats: () => summarize(currentState(), settings()),
    layers: () => LAYERS,
    notebooks: () => NOTEBOOK_LIST,
    auditList: (limit = 50) => currentState().audit.slice(-clampInt(limit, 1, 1000, 50)).reverse(),
    meta: () => currentState().meta,
    // 检索/索引诊断
    searchStats: () => searchEngine.stats(),
    resetSearchStats: () => searchEngine.resetStats(),
    graphNeighbors: (id, options) => searchEngine.graphNeighbors(id, options),
    rebuildIndexes: () => {
      const current = currentState()
      reindexAll()
      if (typeof store.rebuildIndexes === 'function') return store.rebuildIndexes(current.items)
      return { fts: false, vectors: false, items: current.items.length }
    },
    // 写入
    createItem,
    updateItem,
    deleteItems,
    bulkAction,
    runMaintenance,
    // 数据
    exportData,
    importData,
    promptDigest,
    // 设置
    // 注意：这里刻意不调用 currentState()。存储打开时要读 storage.backupKeep，
    // 而它拿设置会回调到这里；如果 getSettings 再去加载状态就会与 load 递归
    // （RangeError: Maximum call stack size exceeded）。启动时显式 await reload()。
    getSettings: () => clone(settings()),
    replaceSettings: async (next) => {
      await ensureLoaded()
      currentState().settings = normalizeSettings(next)
      store.refreshPath?.()
      await persist()
      return currentState().settings
    },
    reload: async () => {
      state = undefined
      itemMap = new Map()
      searchEngine.resetStats()
      return ensureLoaded()
    },
  }
  await api.reload()
  return api
}

// ------------------------------------------------------------------ 工具函数 --

const NOTEBOOK_LIST = []

/** 条目对外视图：补上分层名、是否只读、是否过期。 */
function decorate(item) {
  const info = layerInfo(item.layer)
  return {
    ...item,
    layerName: info.name,
    layerImmutable: info.immutable === true,
    isExpired: item.expiresAt !== null && Date.parse(item.expiresAt) <= Date.now(),
  }
}

function filterItems(items, options, active) {
  const layer = typeof options.layer === 'string' && LAYER_IDS.includes(options.layer) ? options.layer : undefined
  const type = ITEM_TYPES.includes(options.type) ? options.type : undefined
  const notebook = NOTEBOOK_IDS.includes(options.notebook) ? options.notebook : undefined
  // usable = 还能用的条目（active + conflicted），检索默认用它，避免"新写入的冲突条目搜不到"。
  const status = options.status === 'all' || options.status === 'usable'
    ? options.status
    : ITEM_STATUSES.includes(options.status) ? options.status : 'active'
  const tag = typeof options.tag === 'string' && options.tag.trim() !== '' ? options.tag.trim().toLowerCase() : undefined
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const minImportance = clampInt(options.minImportance, 1, 10, 1)
  return items.filter((item) => {
    if (!layerEnabled(active, item.layer)) return false
    if (layer !== undefined && item.layer !== layer) return false
    if (type !== undefined && item.type !== type) return false
    if (notebook !== undefined && item.notebook !== notebook) return false
    if (status === 'usable') {
      if (item.status !== 'active' && item.status !== 'conflicted') return false
    } else if (status !== 'all' && item.status !== status) {
      return false
    }
    if (item.importance < minImportance) return false
    if (tag !== undefined && !item.tags.some((candidate) => candidate.toLowerCase() === tag)) return false
    if (query !== '' && !matchesQuery(item, query)) return false
    return true
  })
}

function matchesQuery(item, query) {
  return item.title.toLowerCase().includes(query)
    || item.content.toLowerCase().includes(query)
    || item.tags.some((tag) => tag.toLowerCase().includes(query))
}

function sortItems(items, sort) {
  const copy = [...items]
  if (sort === 'created') return copy.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  if (sort === 'importance') {
    return copy.sort((left, right) => right.importance - left.importance || right.updatedAt.localeCompare(left.updatedAt))
  }
  if (sort === 'title') return copy.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'))
  return copy.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

/** 关键词加权打分。 */
function scoreItem(item, queryTokens, active, now) {
  const titleTokens = tokenize(item.title)
  const contentTokens = tokenize(item.content)
  const tagTokens = tokenize(item.tags.join(' '))
  let titleHits = 0
  let contentHits = 0
  let tagHits = 0
  for (const token of queryTokens) {
    if (titleTokens.has(token)) titleHits += 1
    if (contentTokens.has(token)) contentHits += 1
    if (tagTokens.has(token)) tagHits += 1
  }
  const querySize = Math.max(1, queryTokens.size)
  const relevance = querySize === 0
    ? 0
    : clampNumber((titleHits * 2 + contentHits + tagHits * 1.5) / (querySize * 2), 0, 1, 0)
  const recency = recencyScore(item.updatedAt, active.retrieval.recencyHalfLifeDays, now)
  const importance = clampNumber(item.importance / 10, 0, 1, 0.5)
  const access = clampNumber(Math.log1p(item.accessCount ?? 0) / Math.log(11), 0, 1, 0)
  const pin = item.pinned ? active.retrieval.pinnedBoost : 0
  const weight = STATUS_WEIGHT[item.status] ?? 0.5
  return (relevance * 0.55 + importance * 0.2 + recency * 0.15 + access * 0.1 + pin) * weight
}

function recencyScore(iso, halfLifeDays, now) {
  const stamp = Date.parse(iso ?? '')
  if (!Number.isFinite(stamp)) return 0
  const days = Math.max(0, (now - stamp) / 86400000)
  const halfLife = Math.max(1, halfLifeDays)
  return Math.pow(0.5, days / halfLife)
}

/** 原生核心需要的时间戳是"秒"，条目里存的是 ISO 字符串。 */
function toImportanceInput(item) {
  const created = Date.parse(item.createdAt ?? '') / 1000
  const lastAccess = Date.parse(item.lastAccessAt ?? item.updatedAt ?? item.createdAt ?? '') / 1000
  return {
    createdAt: Number.isFinite(created) ? created : Date.now() / 1000,
    lastAccessAt: Number.isFinite(lastAccess) ? lastAccess : Date.now() / 1000,
    accessCount: item.accessCount ?? 0,
    relatedCount: Array.isArray(item.conflicts) ? item.conflicts.length : 0,
  }
}

function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const layer = LAYER_IDS.includes(raw.layer) ? raw.layer : 'L5'
  const type = raw.type === 'note' ? 'note' : 'memory'
  const title = truncate(String(raw.title ?? '').trim(), MAX_TITLE)
  const content = truncate(String(raw.content ?? ''), MAX_CONTENT)
  if (title === '' && content.trim() === '') return undefined
  const createdAt = isoOr(raw.createdAt, new Date().toISOString())
  return {
    id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(raw.id) ? raw.id : newId(),
    type,
    layer,
    notebook: type === 'note' ? normalizeNotebook(raw.notebook) : null,
    title: title || deriveTitle(content, type),
    content,
    tags: normalizeTags(raw.tags),
    importance: clampInt(raw.importance, 1, 10, 5),
    status: ITEM_STATUSES.includes(raw.status) ? raw.status : 'active',
    pinned: raw.pinned === true,
    ttlDays: typeof raw.ttlDays === 'number' && Number.isFinite(raw.ttlDays) ? Math.max(1, Math.round(raw.ttlDays)) : null,
    expiresAt: typeof raw.expiresAt === 'string' && Number.isFinite(Date.parse(raw.expiresAt)) ? raw.expiresAt : null,
    source: raw.source !== null && typeof raw.source === 'object' && !Array.isArray(raw.source)
      ? {
        kind: ['user', 'agent', 'system', 'import'].includes(raw.source.kind) ? raw.source.kind : 'user',
        sessionId: typeof raw.source.sessionId === 'string' ? raw.source.sessionId : null,
        workspace: typeof raw.source.workspace === 'string' ? raw.source.workspace : null,
      }
      : { kind: 'user', sessionId: null, workspace: null },
    createdAt,
    updatedAt: isoOr(raw.updatedAt, createdAt),
    lastAccessAt: isoOr(raw.lastAccessAt, createdAt),
    accessCount: clampInt(raw.accessCount, 0, Number.MAX_SAFE_INTEGER, 0),
    version: clampInt(raw.version, 1, Number.MAX_SAFE_INTEGER, 1),
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter((id) => typeof id === 'string').slice(0, 50) : [],
    duplicateOf: typeof raw.duplicateOf === 'string' ? raw.duplicateOf : undefined,
  }
}

function expiresAtFor(item, active) {
  if (item.ttlDays === null || item.ttlDays === undefined) {
    const info = layerInfo(item.layer)
    if (info.ttl !== true) return null
    const days = Math.max(1, active.maintenance.ttlDays)
    return new Date(Date.now() + days * 86400000).toISOString()
  }
  return new Date(Date.now() + Math.max(1, item.ttlDays) * 86400000).toISOString()
}

function normalizeTtl(value, active, layer) {
  if (value === null || value === undefined || value === '' || value === 0) {
    return layerInfo(layer).ttl === true ? Math.max(1, active.maintenance.ttlDays) : null
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.max(1, Math.round(parsed))
}

function normalizeLayer(value) {
  const layer = LAYER_IDS.includes(value) ? value : 'L5'
  return layer
}

function normalizeNotebook(value) {
  return NOTEBOOK_IDS.includes(value) ? value : 'memory'
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，;；\s]+/) : []
  const out = []
  for (const candidate of list) {
    const tag = truncate(String(candidate ?? '').trim(), MAX_TAG_LENGTH)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function deriveTitle(content, type) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return type === 'note' ? '未命名记事' : '未命名记忆'
  return truncate(text, 40)
}

function assertEnabled(active) {
  if (!active.enabled) throw createError('DISABLED', '记忆插件已关闭（设置页可以重新打开）')
}

function assertLayerWritable(active, layer) {
  const info = layerInfo(layer)
  if (!layerEnabled(active, layer)) throw createError('LAYER_DISABLED', `${layer} 已在设置里关闭`)
  if (info.immutable && !active.write.allowImmutableEdit) {
    throw createError('READ_ONLY', `${layer} ${info.name.zh} 是不可变层，只读`)
  }
}

export function createError(code, messageText) {
  const error = new Error(messageText)
  error.code = code
  error.isMemoryError = true
  return error
}

function newId() {
  return `mem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

function isoOr(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max)
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

// 由 index.js 注入，避免循环依赖。
export const TOOL_NAMES = ['memory_write', 'memory_search', 'memory_get', 'memory_update', 'memory_forget', 'memory_stats']

// 记事本列表在模块初始化后填充（NOTEBOOKS 来自 settings.js）。
import { NOTEBOOKS } from './settings.js'
NOTEBOOK_LIST.push(...NOTEBOOKS)

export { message, getPath }








