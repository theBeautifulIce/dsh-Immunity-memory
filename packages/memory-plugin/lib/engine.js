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
  TEMPLATE_LAYER_IDS,
  TEMPLATE_LAYER_META,
  activeTemplate,
  allTemplates,
  clone,
  consolidationTargetFor,
  getPath,
  hasTemplateLayers,
  layerEnabled,
  layerInfo,
  normalizeCustomTemplates,
  normalizeSettings,
  promptBudget,
  sanitizeCustomTemplate,
} from './settings.js'
import { emptyState, message, STORE_VERSION } from './store.js'
import { createSearchEngine } from './search.js'
import { fallbackCosineBatch, fallbackDedupe, fallbackImportance } from './fallback-math.js'
import { estimateTokens, jaccard, tokenize } from './text.js'

export { jaccard, tokenize }

export const ITEM_TYPES = ['memory', 'note']
export const ITEM_STATUSES = ['active', 'archived', 'expired', 'conflicted']
const MAX_TITLE = 240
const MAX_TAGS = 24
const MAX_TAG_LENGTH = 48
const MAX_CONTENT = 200000
const DEDUPE_SCAN_LIMIT = 1200
// 变更快照只保留可审阅的字段；正文过长时保留开头并在 UI/API 标记截断。
const MAX_CHANGE_CONTENT = 4000
const MAX_CHANGE_TEXT = 8000
const MAX_CHANGE_AUDIT = 12000
const CHANGE_FIELDS = ['title', 'content', 'layer', 'notebook', 'tags', 'importance', 'status', 'pinned', 'ttlDays', 'expiresAt']

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
      .slice(-MAX_CHANGE_AUDIT)
      .map(normalizeAuditEntry)
      .filter((entry) => entry !== undefined)
    return next
  }

  // 远程存储（Go 服务）走 load/apply；本地回退走 read/write。
  const remote = typeof store.load === 'function' && typeof store.apply === 'function'

  /** 首次加载：远程存储是异步的（HTTP 到 Go 服务）。 */
  async function ensureLoaded() {
    if (state === undefined) {
      const raw = remote ? await store.load() : store.read()
      state = hydrate(raw)
      const backfilled = backfillLegacyTtl(state, settings())
      reindexAll()
      if (backfilled > 0) {
        audit('ttl.backfill', `${backfilled} 条可修改层记忆补全保鲜期`, 'system')
        await persist()
      }
    }
    return state
  }

  /**
   * 旧版本允许可修改层永久保鲜。加载时一次性补上有限保鲜期，
   * 避免历史数据绕过“必须填写保鲜期”的硬约束。
   */
  function backfillLegacyTtl(current, active) {
    if (current.meta?.ttlBackfillVersion === 1) return 0
    const now = Date.now()
    const defaultDays = Math.max(1, Math.round(Number(active.write.defaultTtlDays) || 30))
    let changed = 0
    for (const item of current.items) {
      if (item.type !== 'memory') continue
      const info = layerInfo(item.layer)
      let touched = false
      if (info.immutable) {
        if (item.ttlDays !== null || item.expiresAt !== null) {
          item.ttlDays = null
          item.expiresAt = null
          touched = true
        }
        if (touched) changed += 1
        continue
      }
      if (item.ttlDays === null || item.ttlDays === undefined) {
        const expires = Date.parse(item.expiresAt ?? '')
        item.ttlDays = Number.isFinite(expires)
          ? Math.max(1, Math.ceil((expires - now) / 86400000))
          : defaultDays
        touched = true
      }
      if (item.expiresAt === null || item.expiresAt === undefined) {
        item.expiresAt = expiresAtFor(item, active)
        touched = true
      }
      if (touched) changed += 1
    }
    current.meta.ttlBackfillVersion = 1
    return changed
  }

  /**
   * 导入的条目也必须遵守保鲜期硬约束：
   * - 记事本没有保鲜期；
   * - 不可变层不设 TTL；
   * - 可修改层的记忆缺 TTL 时补默认值。
   */
  function normalizeImportedTtl(item, active) {
    if (item.type !== 'memory' || layerInfo(item.layer).immutable) {
      const touched = item.ttlDays !== null || item.expiresAt !== null
      item.ttlDays = null
      item.expiresAt = null
      return touched
    }
    let touched = false
    if (item.ttlDays === null || item.ttlDays === undefined) {
      item.ttlDays = Math.max(1, Math.round(Number(active.write.defaultTtlDays) || 30))
      touched = true
    }
    // 导入方可能伪造一个极远的 expiresAt；保鲜期不得超过 ttlDays 对应的上限。
    const maxExpiresAt = Date.parse(expiresAtFor(item, active))
    const importedExpiresAt = Date.parse(item.expiresAt ?? '')
    if (item.expiresAt === null || item.expiresAt === undefined
      || !Number.isFinite(importedExpiresAt) || importedExpiresAt > maxExpiresAt) {
      item.expiresAt = new Date(maxExpiresAt).toISOString()
      touched = true
    }
    return touched
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

  /**
   * 审计与变更历史共用一条持久化通道：
   * - 普通操作只保留 `at/action/detail/actor`；
   * - 结构化变更额外带 `kind:'change'` 与 `change` 快照，用于 diff。
   *
   * 两者分开限流：普通审计默认 200 条，变更历史默认 3000 条，避免 compact
   * 把用户要查的时间段整段裁掉。旧版本没有 kind 的审计记录完全兼容。
   */
  function trimAudit(current) {
    const active = settings()
    if (active.privacy.auditLog === false) {
      current.audit = []
      return
    }
    const auditKeep = Math.max(0, clampInt(active.maintenance.auditKeep, 0, 5000, 200))
    const diffKeep = Math.max(0, clampInt(active.maintenance.diffKeep, 0, 10000, 3000))
    const regular = current.audit.filter((entry) => entry.kind !== 'change').slice(-auditKeep)
    const changes = current.audit.filter((entry) => entry.kind === 'change').slice(-diffKeep)
    current.audit = [...regular, ...changes].sort((left, right) => left.at.localeCompare(right.at))
  }

  function audit(action, detail, actor = 'system') {
    const current = currentState()
    const active = settings()
    if (active.privacy.auditLog === false) {
      current.audit = []
      return
    }
    current.audit.push({ at: new Date().toISOString(), action, detail: truncate(detail, 400), actor })
    trimAudit(current)
  }

  /** 记录一条可 diff 的条目变更；before/after 只保存发生变化的字段。 */
  function recordChange(operation, before, after, actor = 'system', options = {}) {
    const current = currentState()
    const active = settings()
    if (active.privacy.auditLog === false || clampInt(active.maintenance.diffKeep, 0, 10000, 3000) <= 0) return
    const changed = before === null || before === undefined
      ? CHANGE_FIELDS
      : after === null || after === undefined
        ? CHANGE_FIELDS
        : CHANGE_FIELDS.filter((field) => !sameValue(before[field], after[field]))
    if (changed.length === 0 && options.force !== true) return
    const source = after ?? before
    if (source === undefined || source === null) return
    const entry = {
      at: new Date().toISOString(),
      action: 'change',
      kind: 'change',
      detail: truncate(`[${operation}] ${source.layer ?? ''} ${source.title ?? source.id ?? ''}`.trim(), 400),
      actor,
      change: {
        operation,
        entity: source.type === 'note' ? 'note' : 'memory',
        itemId: String(source.id),
        title: String(source.title ?? ''),
        layer: String(source.layer ?? ''),
        notebook: source.notebook ?? null,
        changed,
        before: before === null || before === undefined ? null : changeSnapshot(before, changed),
        after: after === null || after === undefined ? null : changeSnapshot(after, changed),
        reason: typeof options.reason === 'string' ? truncate(options.reason, 400) : '',
      },
    }
    current.audit.push(entry)
    trimAudit(current)
  }

  /** 变更快照：只保留发生变化的字段，正文超限时截断并标记。 */
  function changeSnapshot(item, changed) {
    const snapshot = {}
    for (const field of changed) {
      if (!CHANGE_FIELDS.includes(field)) continue
      if (field === 'content') {
        const text = String(item.content ?? '')
        snapshot.content = truncate(text, MAX_CHANGE_CONTENT)
        snapshot.contentLength = text.length
        snapshot.contentTruncated = text.length > MAX_CHANGE_CONTENT
      } else if (field === 'tags') {
        snapshot.tags = Array.isArray(item.tags) ? item.tags.slice(0, 24) : []
      } else if (field === 'title') {
        snapshot.title = truncate(item.title, MAX_CHANGE_TEXT)
      } else if (field === 'notebook') {
        snapshot.notebook = item.notebook ?? null
      } else {
        snapshot[field] = item[field] ?? null
      }
    }
    snapshot.id = item.id
    snapshot.type = item.type
    snapshot.version = item.version
    return snapshot
  }

  // ------------------------------------------------------- 用量 / 强化信号 ----
  // 用量账本与固化状态都放在 meta 里：Go 服务的 meta 走 /config 整体同步，
  // 不需要改 SQLite 表结构，也不会因为新增字段而丢数据。

  const MAX_USAGE_RECENT = 200

  function usageLedger() {
    const current = currentState()
    if (current.meta.usage === null || typeof current.meta.usage !== 'object') {
      current.meta.usage = {
        calls: 0,
        queryTokens: 0,
        resultTokens: 0,
        byTool: {},
        byType: {},
        recent: [],
      }
    }
    const ledger = current.meta.usage
    if (!Array.isArray(ledger.recent)) ledger.recent = []
    if (ledger.byTool === null || typeof ledger.byTool !== 'object') ledger.byTool = {}
    if (ledger.byType === null || typeof ledger.byType !== 'object') ledger.byType = {}
    return ledger
  }

  function emptyUsageBucket() {
    return { calls: 0, queryTokens: 0, resultTokens: 0 }
  }

  function bumpUsage(bucket, queryTokens, resultTokens) {
    bucket.calls = (bucket.calls ?? 0) + 1
    bucket.queryTokens = (bucket.queryTokens ?? 0) + queryTokens
    bucket.resultTokens = (bucket.resultTokens ?? 0) + resultTokens
  }

  /**
   * 记录一次「智能体查询」的 token 成本。
   * 只有带 actor 的调用才记账（工具调用），设置页自己刷新列表不算。
   */
  function recordUsage(tool, options, items) {
    if (typeof options?.actor !== 'string' || options.actor === '') return null
    const ledger = usageLedger()
    const query = typeof options.query === 'string' ? options.query : ''
    const queryTokens = estimateTokens(query)
    const typeTokens = { note: 0, memory: 0 }
    let resultTokens = 0
    for (const item of items) {
      const tags = Array.isArray(item.tags) ? item.tags.join(' ') : ''
      const tokens = estimateTokens(`${item.id} ${item.layer} ${item.title} ${item.content} ${tags}`)
      resultTokens += tokens
      if (item.type === 'note' || item.type === 'memory') typeTokens[item.type] += tokens
    }
    const type = options.type === 'note' ? 'note' : options.type === 'memory' ? 'memory' : 'all'
    bumpUsage(ledger, queryTokens, resultTokens)
    ledger.byTool[tool] = ledger.byTool[tool] ?? emptyUsageBucket()
    bumpUsage(ledger.byTool[tool], queryTokens, resultTokens)
    ledger.byType[type] = ledger.byType[type] ?? emptyUsageBucket()
    bumpUsage(ledger.byType[type], queryTokens, resultTokens)
    ledger.recent.push({
      at: new Date().toISOString(),
      tool,
      actor: options.actor,
      type,
      typeTokens,
      // 关闭操作审计时不落查询原文，避免把可能含隐私的检索词写进账本。
      query: settings().privacy.auditLog === false ? '' : truncate(query, 120),
      queryTokens,
      resultTokens,
      results: items.length,
    })
    if (ledger.recent.length > MAX_USAGE_RECENT) ledger.recent = ledger.recent.slice(-MAX_USAGE_RECENT)
    scheduleAccessPersist()
    return { queryTokens, resultTokens, totalTokens: queryTokens + resultTokens }
  }

  /** 查询用量：按工具 / 类型 / 时间过滤，返回汇总与最近明细。 */
  function usageStats(options = {}) {
    const ledger = usageLedger()
    const since = typeof options.since === 'string' && options.since !== '' ? Date.parse(options.since) : 0
    const tool = typeof options.tool === 'string' && options.tool !== '' ? options.tool : ''
    const type = options.type === 'note' || options.type === 'memory' ? options.type : ''
    const matches = (entry) => {
      if (tool !== '' && entry.tool !== tool) return false
      if (type !== '' && entry.type !== type && !((entry.typeTokens?.[type] ?? 0) > 0)) return false
      if (since > 0 && Date.parse(entry.at) < since) return false
      return true
    }
    const recent = ledger.recent.filter(matches)
    const sum = recent.reduce((acc, entry) => {
      acc.calls += 1
      acc.queryTokens += entry.queryTokens ?? 0
      acc.resultTokens += type === ''
        ? (entry.resultTokens ?? 0)
        : (entry.typeTokens?.[type] ?? (entry.type === type ? entry.resultTokens ?? 0 : 0))
      return acc
    }, { calls: 0, queryTokens: 0, resultTokens: 0 })
    // 分组统计跟随当前筛选，避免“筛选记事本却看到全量桶”的误读。
    const byTool = {}
    const byType = {}
    for (const entry of recent) {
      const result = type === ''
        ? (entry.resultTokens ?? 0)
        : (entry.typeTokens?.[type] ?? (entry.type === type ? entry.resultTokens ?? 0 : 0))
      byTool[entry.tool] = byTool[entry.tool] ?? emptyUsageBucket()
      bumpUsage(byTool[entry.tool], entry.queryTokens ?? 0, result)
      const typeKey = type === '' ? entry.type : type
      byType[typeKey] = byType[typeKey] ?? emptyUsageBucket()
      bumpUsage(byType[typeKey], entry.queryTokens ?? 0, result)
    }
    return {
      ...sum,
      totalTokens: sum.queryTokens + sum.resultTokens,
      allTime: {
        calls: ledger.calls ?? 0,
        queryTokens: ledger.queryTokens ?? 0,
        resultTokens: ledger.resultTokens ?? 0,
      },
      byTool,
      byType,
      recent: recent.slice(-50).reverse(),
      filters: { since: options.since ?? null, tool: tool || null, type: type || null },
    }
  }

  function reinforcementMap() {
    const current = currentState()
    if (current.meta.reinforcement === null || typeof current.meta.reinforcement !== 'object') {
      current.meta.reinforcement = {}
    }
    return current.meta.reinforcement
  }

  /** 强化信号：写入 / 更新 / 检索命中。 */
  function reinforce(item, kind) {
    if (item?.type !== 'memory') return
    const map = reinforcementMap()
    const now = new Date().toISOString()
    const record = map[item.id] ?? {
      count: 0,
      firstAt: now,
      lastAt: now,
      create: 0,
      update: 0,
      hit: 0,
    }
    record.count = (record.count ?? 0) + 1
    record.lastAt = now
    record[kind] = (record[kind] ?? 0) + 1
    map[item.id] = record
  }

  function pruneMetaFor(ids) {
    const current = currentState()
    const keep = new Set(ids)
    for (const key of ['reinforcement', 'consolidation']) {
      const map = current.meta[key]
      if (map === null || typeof map !== 'object') continue
      for (const id of Object.keys(map)) {
        if (!keep.has(id)) delete map[id]
      }
    }
  }

  /** 固化候选：窗口内强化次数达到阈值、可修改层、状态可用的记忆。 */
  function consolidationCandidates(options = {}) {
    const current = currentState()
    const active = settings()
    if (active.consolidation.enabled !== true) return []
    const now = Date.now()
    const map = reinforcementMap()
    const records = current.meta.consolidation !== null && typeof current.meta.consolidation === 'object'
      ? current.meta.consolidation
      : {}
    const windowMs = Math.max(1, active.consolidation.windowDays) * 86400000
    const threshold = Math.max(2, active.consolidation.threshold)
    const out = []
    for (const item of current.items) {
      if (item.type !== 'memory') continue
      if (item.status !== 'active' && item.status !== 'conflicted') continue
      if (isExpiredItem(item, now)) continue
      if (layerInfo(item.layer).immutable) continue
      if (item.importance < active.consolidation.minImportance) continue
      const signal = map[item.id]
      if (signal === undefined) continue
      if (signal.count < threshold) continue
      if (now - Date.parse(signal.lastAt) > windowMs) continue
      const record = records[item.id]
      if (record?.state === 'approved' && Date.parse(record.at) >= Date.parse(signal.lastAt)) continue
      if (record?.state === 'rejected' && Date.parse(record.at) >= Date.parse(signal.lastAt)) continue
      const ageDays = Math.max(0, (now - Date.parse(signal.firstAt)) / 86400000)
      out.push({
        id: item.id,
        title: item.title,
        layer: item.layer,
        layerName: layerInfo(item.layer).name,
        importance: item.importance,
        status: item.status,
        accessCount: item.accessCount ?? 0,
        signals: signal.count,
        windowDays: Math.round(ageDays * 10) / 10,
        firstAt: signal.firstAt,
        lastAt: signal.lastAt,
        breakdown: { create: signal.create ?? 0, update: signal.update ?? 0, hit: signal.hit ?? 0 },
        suggestedLayer: consolidationTargetFor(item.layer, active),
        permanent: true,
        state: record?.state ?? 'new',
      })
    }
    out.sort((left, right) => right.signals - left.signals || right.importance - left.importance)
    const cap = Math.max(1, active.consolidation.maxCandidates)
    return typeof options.limit === 'number' ? out.slice(0, Math.max(1, Math.min(cap, options.limit))) : out.slice(0, cap)
  }

  /** 把候选写进审计（每轮只记录新出现的候选，避免刷屏）。 */
  function proposeConsolidation(current, active) {
    const candidates = consolidationCandidates()
    if (candidates.length === 0) return { proposed: 0, candidates: [] }
    if (current.meta.consolidation === null || typeof current.meta.consolidation !== 'object') {
      current.meta.consolidation = {}
    }
    const records = current.meta.consolidation
    let proposed = 0
    for (const candidate of candidates) {
      const record = records[candidate.id]
      if (record?.state === 'candidate') continue
      records[candidate.id] = {
        state: 'candidate',
        at: new Date().toISOString(),
        signals: candidate.signals,
        score: candidate.signals * (1 + candidate.importance / 10),
        suggestedLayer: candidate.suggestedLayer,
      }
      audit('consolidation.proposed', `${candidate.id} ${candidate.layer} ${candidate.title}（信号 ${candidate.signals}）`, 'system')
      proposed += 1
    }
    return { proposed, candidates }
  }

  /**
   * 固化审计的最终动作：智能体确认后调用。
   * approve 会把层级提升到 L1（思想核心）或 L3（本能行为）——两者都不可变、
   * 永久有效，并清空保鲜期；reject 只记录理由，等新的强化信号再重新进入候选。
   */
  async function applyConsolidation(id, decision, options = {}, actor = 'agent') {
    const current = await ensureLoaded()
    const active = settings()
    if (active.consolidation.enabled !== true) throw createError('CONSOLIDATION_OFF', '固化功能已在设置里关闭')
    const item = current.items.find((candidate) => candidate.id === id)
    if (item === undefined) throw createError('NOT_FOUND', `找不到条目 ${id}`)
    if (layerInfo(item.layer).immutable) throw createError('READ_ONLY', `${item.layer} 是不可变层，不需要固化`)
    if (decision !== 'approve' && decision !== 'reject') {
      throw createError('INVALID_DECISION', 'decision 只能是 approve 或 reject')
    }
    const now = new Date().toISOString()
    const records = current.meta.consolidation !== null && typeof current.meta.consolidation === 'object'
      ? current.meta.consolidation
      : (current.meta.consolidation = {})
    const note = typeof options.note === 'string' ? truncate(options.note, 240) : ''
    if (decision === 'reject') {
      records[id] = {
        state: 'rejected',
        at: now,
        by: actor,
        note,
        signals: current.meta.reinforcement?.[id]?.count ?? 0,
      }
      audit('consolidation.rejected', `${id} ${item.layer} ${item.title}${note === '' ? '' : `：${note}`}`, actor)
      await persist()
      return { decision: 'reject', record: records[id], item: decorate(item) }
    }
    const targetLayer = options.targetLayer === undefined
      ? consolidationTargetFor(item.layer, active)
      : String(options.targetLayer)
    if (targetLayer !== 'L1' && targetLayer !== 'L3') {
      throw createError('INVALID_LAYER', '固化目标只能是 L1 思想核心或 L3 本能行为')
    }
    if (!layerEnabled(active, targetLayer)) throw createError('LAYER_DISABLED', `${targetLayer} 已在设置里关闭`)
    if (records[id]?.state !== 'candidate') {
      throw createError('NOT_CANDIDATE', `条目 ${id} 不在固化候选状态，请先扫描强化信号`)
    }
    const fromLayer = item.layer
    const beforeChange = clone(item)
    item.layer = targetLayer
    item.ttlDays = null
    item.expiresAt = null
    item.importance = Math.max(item.importance, active.consolidation.minImportance)
    item.updatedAt = now
    item.version = (item.version ?? 1) + 1
    if (item.status === 'conflicted') item.status = 'active'
    records[id] = {
      state: 'approved',
      at: now,
      by: actor,
      note,
      fromLayer,
      toLayer: targetLayer,
      permanent: true,
      signals: current.meta.reinforcement?.[id]?.count ?? 0,
      score: (current.meta.reinforcement?.[id]?.count ?? 0) * (1 + item.importance / 10),
    }
    indexItem(item)
    recordChange('consolidate', beforeChange, item, actor, { reason: `永久固化 ${fromLayer} → ${targetLayer}${note === '' ? '' : `；${note}`}` })
    audit('consolidation.approved', `${id} ${fromLayer} → ${targetLayer} ${item.title}（永久固化${note === '' ? '' : `；${note}`}）`, actor)
    await persist()
    return { decision: 'approve', record: records[id], item: decorate(item) }
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
        reinforce(item, 'hit')
      }
      if (sorted.length > 0) scheduleAccessPersist()
      current.meta.searches = (current.meta.searches ?? 0) + 1
      const listed = sorted.map((item) => ({ ...decorate(item), score: round(scoreItem(item, new Set(), active, Date.now())) }))
      return {
        items: listed,
        total: scope.length,
        query,
        limit,
        tokens: 0,
        usage: recordUsage('memory_search', options, listed),
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
        if (isExpiredItem(item, started)) continue
        item.accessCount = (item.accessCount ?? 0) + 1
        item.lastAccessAt = new Date().toISOString()
        reinforce(item, 'hit')
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
        usage: recordUsage('memory_search', options, hits),
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
      if (isExpiredItem(item, started)) continue
      item.accessCount = (item.accessCount ?? 0) + 1
      item.lastAccessAt = new Date().toISOString()
      reinforce(item, 'hit')
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
      usage: recordUsage('memory_search', options, hits),
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

  /**
   * 时间段变更查询。数据来自结构化审计记录（kind='change'），
   * 可按实体类型、记忆层、条目 id 和时间范围过滤；默认最近 7 天。
   */
  async function diff(options = {}) {
    const current = await ensureLoaded()
    const active = settings()
    const now = Date.now()
    const since = parseTimeOption(options.since, now - 7 * 86400000)
    const until = parseTimeOption(options.until, now)
    if (since === undefined || until === undefined) {
      throw createError('INVALID_RANGE', 'since/until 必须是 ISO 时间或可解析的日期')
    }
    if (since > until) throw createError('INVALID_RANGE', 'since 不能晚于 until')
    const entity = ['memory', 'note', 'all'].includes(options.entity) ? options.entity : 'all'
    const layer = LAYER_IDS.includes(options.layer) ? options.layer : undefined
    const itemId = typeof options.itemId === 'string' && options.itemId !== '' ? options.itemId : undefined
    const operation = typeof options.operation === 'string' && options.operation !== '' ? options.operation : undefined
    const limit = clampInt(options.limit, 1, 200, 50)
    const offset = clampInt(options.offset, 0, Number.MAX_SAFE_INTEGER, 0)
    const from = new Date(since).toISOString()
    const to = new Date(until).toISOString()
    const all = current.audit
      .filter((entry) => entry.kind === 'change' && entry.change !== undefined)
      .filter((entry) => entry.at >= from && entry.at <= to)
      .filter((entry) => entity === 'all' || entry.change.entity === entity)
      .filter((entry) => layer === undefined || entry.change.layer === layer)
      .filter((entry) => itemId === undefined || entry.change.itemId === itemId)
      .filter((entry) => operation === undefined || entry.change.operation === operation)
      .sort((left, right) => right.at.localeCompare(left.at))
    const counts = {
      operation: {},
      entity: { memory: 0, note: 0 },
      layer: Object.fromEntries(LAYER_IDS.map((id) => [id, 0])),
    }
    for (const entry of all) {
      const change = entry.change
      counts.operation[change.operation] = (counts.operation[change.operation] ?? 0) + 1
      counts.entity[change.entity] = (counts.entity[change.entity] ?? 0) + 1
      if (change.layer !== '') counts.layer[change.layer] = (counts.layer[change.layer] ?? 0) + 1
    }
    const page = all.slice(offset, offset + limit).map((entry) => ({
      at: entry.at,
      actor: entry.actor,
      summary: changeSummary(entry.change),
      ...entry.change,
      before: trimChangeSnapshot(entry.change.before, options.includeContent === true),
      after: trimChangeSnapshot(entry.change.after, options.includeContent === true),
    }))
    const changes = current.audit.filter((entry) => entry.kind === 'change')
    return {
      range: { since: from, until: to },
      filters: { entity, layer: layer ?? null, itemId: itemId ?? null, operation: operation ?? null },
      total: all.length,
      offset,
      limit,
      counts,
      changes: page,
      retention: {
        limit: Math.max(0, clampInt(active.maintenance.diffKeep, 0, 10000, 3000)),
        kept: changes.length,
        oldest: changes[0]?.at ?? null,
        newest: changes[changes.length - 1]?.at ?? null,
      },
    }
  }

  /** 解析踩坑 Markdown 的四个固定段落；缺失字段返回空串。 */
  function parsePitfallContent(content) {
    const text = String(content ?? '')
    const section = (name) => {
      const pattern = new RegExp(`(?:^|\\n)##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`)
      return pattern.exec(text)?.[1]?.trim() ?? ''
    }
    return {
      problem: section('现象'),
      cause: section('根因'),
      solution: section('解决办法'),
      prevention: section('预防'),
    }
  }

  function decoratePitfall(item) {
    return { ...decorate(item), pitfall: parsePitfallContent(item.content) }
  }

  /** 新增一条踩坑笔记；内容统一成四段，便于人和智能体稳定读取。 */
  async function recordPitfall(input = {}, actor = 'agent') {
    const active = settings()
    assertEnabled(active)
    const problem = truncate(String(input.problem ?? input.title ?? '').trim(), MAX_CONTENT)
    const cause = truncate(String(input.cause ?? '').trim(), MAX_CONTENT)
    const solution = truncate(String(input.solution ?? '').trim(), MAX_CONTENT)
    const prevention = truncate(String(input.prevention ?? '').trim(), MAX_CONTENT)
    if (problem === '' || solution === '') {
      throw createError('PITFALL_REQUIRED', '踩坑笔记至少需要 problem（现象）和 solution（解决办法）')
    }
    const title = truncate(String(input.title ?? problem).trim(), 120) || '未命名踩坑'
    const content = [
      '## 现象',
      problem,
      '',
      '## 根因',
      cause === '' ? '待补充。' : cause,
      '',
      '## 解决办法',
      solution,
      '',
      '## 预防',
      prevention === '' ? '待补充。' : prevention,
    ].join('\n')
    const layer = input.layer === undefined ? 'L4' : normalizeLayer(input.layer)
    const item = await createItem({
      type: 'note',
      notebook: 'pitfall',
      layer,
      title,
      content,
      tags: ['踩坑', ...(Array.isArray(input.tags) ? input.tags : [])],
      importance: input.importance ?? 7,
      pinned: input.pinned === true,
      sessionId: input.sessionId,
      workspace: input.workspace,
    }, actor)
    return { item: decoratePitfall(item), duplicateOf: item.duplicateOf ?? null }
  }

  /** 查踩坑：query 为空时按最近更新列出；有 query 时走混合检索。 */
  async function searchPitfalls(options = {}) {
    const active = settings()
    const limit = clampInt(options.limit, 1, 50, 10)
    const query = typeof options.query === 'string' ? options.query.trim() : ''
    if (query === '') {
      const result = listItems({ type: 'note', notebook: 'pitfall', status: 'usable', limit, sort: 'updated' })
      return {
        query,
        total: result.total,
        items: result.items.map(decoratePitfall),
      }
    }
    const result = await searchItems({
      ...options,
      query,
      type: 'note',
      notebook: 'pitfall',
      status: 'usable',
      limit,
      actor: options.actor ?? 'agent',
    })
    return {
      query,
      total: result.total,
      items: result.items.map(decoratePitfall),
      tookMs: result.tookMs,
      usage: result.usage,
    }
  }

  /** 智能体写入前查重：返回已有踩坑及解决办法，避免重复踩同一个坑。 */
  async function checkPitfalls(input = {}) {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query === '') throw createError('QUERY_REQUIRED', 'check 需要 query（当前任务/错误现象）')
    const result = await searchPitfalls({ query, limit: input.limit ?? 5 })
    return {
      query,
      found: result.items.length > 0,
      total: result.total,
      items: result.items,
      advice: result.items.length === 0
        ? '没有找到历史踩坑记录；遇到新问题并解决后，用 memory_pitfall record 记录下来。'
        : '先复用这些历史解决办法；如果仍不适用，解决新问题后用 memory_pitfall record 补充。',
    }
  }

  // ---------------------------------------------------------------- 写入 ----

  async function createItem(input = {}, actor = 'user') {
    const current = await ensureLoaded()
    const active = settings()
    assertEnabled(active)
    // 写入哪一层由调用方（智能体 / 用户）按内容判断；智能体不得依赖服务端默认层。
    let layer
    if (input.layer !== undefined) {
      layer = normalizeLayer(input.layer)
    } else if (actor === 'agent') {
      throw createError('LAYER_REQUIRED', 'memory_write 必须由智能体显式选择可修改层（L2/L4/L5/L6/L7）')
    } else {
      layer = 'L4'
    }
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
    if (duplicate !== undefined) {
      item.duplicateOf = duplicate.id
      // 同一条事实被反复强调，也是固化信号。
      reinforce(duplicate, 'create')
    }
    // 保鲜期：可修改层的条目到期后由清理任务归档；不可变层恒为永久。
    item.expiresAt = expiresAtFor(item, active)
    reinforce(item, 'create')
    current.items.push(item)
    indexItem(item)
    detectConflicts(current, item, active)
    audit('create', `${item.layer}/${item.type} ${item.title}`, actor)
    recordChange('create', null, item, actor)
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
    const beforeChange = clone(before)
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
      // 不可变层不允许携带保鲜期，移入时一并清掉。
      if (layerInfo(layer).immutable) next.ttlDays = null
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
    // 修改可修改层的内容/重要度时必须续期：老数据没有 ttlDays 时要求这次补填。
    const contentTouched = patch.title !== undefined || patch.content !== undefined
      || patch.tags !== undefined || patch.importance !== undefined || patch.layer !== undefined
    if (contentTouched && next.type === 'memory' && !layerInfo(next.layer).immutable
      && patch.ttlDays === undefined) {
      throw createError('TTL_REQUIRED', `修改 ${next.layer} 记忆时必须同时填写或更新 ttlDays（保鲜期）`)
    }
    next.updatedAt = new Date().toISOString()
    next.version = (before.version ?? 1) + 1
    next.expiresAt = expiresAtFor(next, active)
    current.items[index] = normalizeItem(next) ?? before
    reinforce(current.items[index], 'update')
    indexItem(current.items[index])
    detectConflicts(current, current.items[index], active)
    audit('update', `${current.items[index].layer}/${current.items[index].title}`, actor)
    recordChange('update', beforeChange, current.items[index], actor)
    await persist()
    return decorate(current.items[index])
  }

  async function deleteItems(ids, actor = 'user') {
    const current = await ensureLoaded()
    const active = settings()
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string'))
    if (wanted.size === 0) return { deleted: 0 }
    const removed = []
    const removedItems = []
    current.items = current.items.filter((item) => {
      if (!wanted.has(item.id)) return true
      if (layerInfo(item.layer).immutable && !active.write.allowImmutableEdit) {
        log('warn', `拒绝删除不可变分层的条目 ${item.id}（${item.layer}）`)
        return true
      }
      removed.push(item.id)
      removedItems.push(clone(item))
      return false
    })
    for (const item of current.items) {
      item.conflicts = item.conflicts.filter((other) => !removed.includes(other))
      if (item.conflicts.length === 0 && item.status === 'conflicted') item.status = 'active'
    }
    if (removed.length > 0) {
      for (const id of removed) unindexItem(id)
      pruneMetaFor(current.items.map((item) => item.id))
      for (const item of removedItems) recordChange('delete', item, null, actor)
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
      const before = changed
      const beforeChange = clone(item)
      if (action === 'archive' && item.status !== 'archived') {
        item.status = 'archived'
        changed += 1
      } else if (action === 'restore' && item.status !== 'active') {
        item.status = 'active'
        // 恢复已过期条目时补一次保鲜期，否则下一次 cleanup 会立刻再归档。
        if (layerInfo(item.layer).immutable) {
          item.ttlDays = null
          item.expiresAt = null
        } else if (item.type === 'memory' && (item.expiresAt === null || Date.parse(item.expiresAt) <= Date.now())) {
          item.ttlDays = Math.max(1, Math.round(Number(item.ttlDays) || Number(active.write.defaultTtlDays) || 30))
          item.expiresAt = expiresAtFor(item, active)
        }
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
      if (changed > before) {
        // 提升/降低重要度属于“修改”，同步续期，避免绕过保鲜期硬约束。
        if ((action === 'promote' || action === 'demote') && item.type === 'memory') {
          if (layerInfo(item.layer).immutable) {
            item.ttlDays = null
            item.expiresAt = null
          } else {
            item.ttlDays = Math.max(1, Math.round(Number(item.ttlDays) || Number(active.write.defaultTtlDays) || 30))
            item.expiresAt = expiresAtFor(item, active)
          }
        }
        item.updatedAt = new Date().toISOString()
        item.version = (item.version ?? 1) + 1
        recordChange('bulk', beforeChange, item, actor, { reason: action })
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
      : ['cleanup', 'rotate', 'archive', 'dedupe', 'reflect', 'consolidate']
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
      } else if (task === 'consolidate') {
        const proposal = proposeConsolidation(current, active)
        let applied = 0
        if (active.consolidation.autoApply === true) {
          for (const candidate of proposal.candidates) {
            try {
              await applyConsolidation(candidate.id, 'approve', { note: '维护任务自动固化' }, 'system')
              applied += 1
            } catch (error) {
              audit('consolidation.failed', `${candidate.id}：${error?.message ?? error}`, 'system')
            }
          }
        }
        dirty = true
        report.tasks.push({
          task,
          changed: proposal.proposed,
          applied,
          note: `新增固化候选 ${proposal.proposed} 条${applied > 0 ? `，自动固化 ${applied} 条` : '，等待智能体审计'}`,
          candidates: proposal.candidates,
        })
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
    const consolidation = current.meta.consolidation !== null && typeof current.meta.consolidation === 'object'
      ? current.meta.consolidation
      : {}
    const consolidationState = { candidate: 0, approved: 0, rejected: 0 }
    for (const record of Object.values(consolidation)) {
      if (record?.state !== undefined && consolidationState[record.state] !== undefined) {
        consolidationState[record.state] += 1
      }
    }
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
      usage: {
        calls: current.meta.usage?.calls ?? 0,
        queryTokens: current.meta.usage?.queryTokens ?? 0,
        resultTokens: current.meta.usage?.resultTokens ?? 0,
      },
      consolidation: consolidationState,
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
    let ttlFilled = 0
    const existingIds = new Set(current.items.map((item) => item.id))
    // replace 模式也不能借导入覆盖受保护的不可变层条目。
    const protectedIds = mode === 'replace'
      ? new Set(current.items
        .filter((item) => layerInfo(item.layer).immutable && !active.write.allowImmutableEdit)
        .map((item) => item.id))
      : null
    for (const candidate of incoming) {
      const normalized = normalizeItem(candidate)
      if (normalized === undefined) {
        skipped += 1
        continue
      }
      if (protectedIds !== null && protectedIds.has(normalized.id)) {
        skipped += 1
        continue
      }
      if (mode !== 'replace' && existingIds.has(normalized.id)) normalized.id = newId()
      existingIds.add(normalized.id)
      normalized.source = { ...normalized.source, kind: 'import' }
      if (normalizeImportedTtl(normalized, active)) ttlFilled += 1
      imported.push(normalized)
    }
    if (mode === 'replace') {
      const keep = current.items.filter((item) => layerInfo(item.layer).immutable && !active.write.allowImmutableEdit)
      const replaced = new Map(keep.map((item) => [item.id, item]))
      for (const item of imported) replaced.set(item.id, item)
      current.items = [...replaced.values()]
    } else {
      current.items = [...current.items, ...imported]
    }
    reindexAll()
    if (payload?.settings !== undefined && mode === 'replace') current.settings = normalizeSettings(payload.settings)
    audit('import', `导入 ${imported.length} 条（跳过 ${skipped}${ttlFilled > 0 ? `，补全保鲜期 ${ttlFilled}` : ''}）`, 'user')
    await persist()
    return { imported: imported.length, skipped, ttlFilled, mode }
  }

  /** 模板不可变层的条目数量（用于 API/UI 展示，不包含共享记忆）。 */
  function templateLayerCounts(template) {
    const counts = { L0: 0, L1: 0, L3: 0 }
    for (const id of TEMPLATE_LAYER_IDS) counts[id] = template?.layers?.[id]?.length ?? 0
    return counts
  }

  /**
   * 构造提示词注入：模板头 + 模板不可变层 + 共享可改写记忆。
   * 模板自带 L0/L1/L3 时，数据库中同层条目不再重复注入；没有模板层的旧配置
   * 仍按老行为注入数据库里的不可变层，保持向前兼容。
   * promptDigest 只要文本；injectionStats 还要每层 token 明细，两者共用这一份结果，
   * 避免 UI 看到的预算与实际注入的不是同一套算法。
   */
  function buildDigest(now = Date.now()) {
    const current = currentState()
    const active = settings()
    const template = activeTemplate(active)
    const budget = promptBudget(active)
    const enabled = active.enabled !== false && active.prompt.inject !== false && budget.topN > 0
    const empty = {
      enabled,
      text: '',
      preview: '',
      tokens: 0,
      chars: 0,
      topN: budget.topN,
      maxChars: budget.maxChars,
      truncated: false,
      template: {
        id: template.id,
        name: template.name,
        desc: template.desc,
        layers: templateLayerCounts(template),
      },
      itemCount: 0,
      templateItemCount: 0,
      sharedItemCount: 0,
      headerTokens: 0,
      headerChars: 0,
      headerPercent: 0,
      lines: [],
      layers: LAYERS.map((layer) => ({
        id: layer.id,
        name: layer.name,
        disabled: !layerEnabled(active, layer.id),
        count: 0,
        tokens: 0,
        chars: 0,
        percent: 0,
      })),
    }
    if (!enabled) return empty
    const configuredImmutable = hasTemplateLayers(template)
    const templateEntries = []
    if (configuredImmutable) {
      for (const id of TEMPLATE_LAYER_IDS) {
        if (!layerEnabled(active, id)) continue
        const meta = TEMPLATE_LAYER_META.find((layer) => layer.id === id)
        for (const entry of template.layers?.[id] ?? []) {
          templateEntries.push({
            id: `template:${id}:${templateEntries.length}`,
            layer: id,
            layerName: meta?.name,
            title: entry.title,
            content: entry.content,
          })
        }
      }
    }
    const candidates = current.items.filter((item) => {
      if (item.status !== 'active' && item.status !== 'conflicted') return false
      if (isExpiredItem(item, now)) return false
      if (!layerEnabled(active, item.layer)) return false
      if (item.type !== 'memory') return false
      // 模板已经提供不可变层时，以模板为准，避免数据库里的旧同层条目重复注入。
      if (configuredImmutable && layerInfo(item.layer).immutable) return false
      return true
    })
    const scored = candidates.map((item) => ({ item, score: scoreItem(item, new Set(), active, now) }))
    scored.sort((left, right) => right.score - left.score)
    const chosen = scored.slice(0, budget.topN)
    // 空库也要注入模板头部：否则新会话只剩工具描述，模型不知道有长期记忆可用。
    const coldStart = chosen.length === 0 && templateEntries.length === 0
    const lines = []
    const lineMeta = []
    for (const entry of templateEntries) {
      const layerLabel = entry.layerName?.zh ?? entry.layer
      const body = truncate(String(entry.content).replace(/\s+/g, ' ').trim(), 800)
      lines.push(`- [${entry.layer} ${layerLabel}·模板] ${entry.title}：${body}`)
      lineMeta.push({ ...entry, source: 'template', importance: null })
    }
    for (const { item } of chosen) {
      const body = truncate(item.content.replace(/\s+/g, ' ').trim(), 220)
      lines.push(`- [${item.layer}·重要度${item.importance}] ${item.title}：${body}`)
      lineMeta.push({ id: item.id, title: item.title, layer: item.layer, importance: item.importance, source: 'memory' })
    }
    const header = coldStart
      ? [
          template.header,
          '（当前没有已保存的相关条目。遇到值得跨会话保留的事实、偏好或决策时，请用 memory_write 保存，并填写保鲜期。）',
        ].filter((part) => part !== '').join('\n')
      : template.header
    let text = [header, ...lines].filter((part) => part !== '').join('\n')
    let truncated = false
    if (budget.maxChars > 0 && text.length > budget.maxChars) {
      text = `${text.slice(0, Math.max(0, budget.maxChars - 1))}…`
      truncated = true
    }
    const headerTokens = estimateTokens(header)
    const lineTokens = lines.map((line) => estimateTokens(line))
    const lineTokenSum = lineTokens.reduce((sum, value) => sum + value, 0)
    const totalTokens = estimateTokens(text)
    const headerPercent = totalTokens === 0
      ? 0
      : Math.min(100, Math.round((headerTokens / totalTokens) * 1000) / 10)
    // 截断可能切掉半行：按剩余预算等比例折算，保证每层之和 ≈ 实际注入。
    const scale = truncated && lineTokenSum > 0
      ? Math.max(0, totalTokens - Math.min(headerTokens, totalTokens)) / lineTokenSum
      : 1
    const byLayer = new Map(LAYERS.map((layer) => [layer.id, {
      id: layer.id,
      name: layer.name,
      disabled: !layerEnabled(active, layer.id),
      count: 0,
      tokens: 0,
      chars: 0,
      percent: 0,
    }]))
    const lineStats = []
    lineMeta.forEach((entry, index) => {
      const tokens = Math.max(0, Math.round(lineTokens[index] * scale))
      const bucket = byLayer.get(entry.layer)
      if (bucket !== undefined) {
        bucket.count += 1
        bucket.tokens += tokens
        bucket.chars += lines[index].length
      }
      lineStats.push({
        id: entry.id,
        title: entry.title,
        layer: entry.layer,
        importance: entry.importance,
        source: entry.source,
        tokens,
        chars: lines[index].length,
      })
    })
    const layers = [...byLayer.values()].map((bucket) => ({
      ...bucket,
      percent: totalTokens === 0 ? 0 : Math.round((bucket.tokens / totalTokens) * 1000) / 10,
    }))
    return {
      enabled,
      text,
      preview: text.slice(0, 2000),
      tokens: totalTokens,
      chars: text.length,
      topN: budget.topN,
      maxChars: budget.maxChars,
      truncated,
      template: {
        id: template.id,
        name: template.name,
        desc: template.desc,
        layers: templateLayerCounts(template),
      },
      itemCount: lineStats.length,
      templateItemCount: templateEntries.length,
      sharedItemCount: chosen.length,
      headerTokens,
      headerChars: header.length,
      headerPercent,
      lines: lineStats,
      layers,
    }
  }

  /** 提示词注入用的摘要文本。 */
  function promptDigest(now = Date.now()) {
    return buildDigest(now).text
  }

  /** 注入预算明细（UI 与 API 用）。 */
  function injectionStats(now = Date.now()) {
    return buildDigest(now)
  }

  /** 内置 + 自定义模板；自定义模板由用户随时新增、编辑、删除、切换。 */
  function templates() {
    const active = settings()
    return { active: activeTemplate(active).id, list: allTemplates(active) }
  }

  async function saveTemplate(input = {}, actor = 'user') {
    const current = await ensureLoaded()
    const next = normalizeSettings(current.settings)
    // 编辑时允许只提交部分字段：未提交的名称/头/预算/层沿用旧值，避免一次局部保存把层清空。
    const previous = input.id === undefined
      ? undefined
      : (next.prompt.customTemplates ?? []).find((template) => template.id === input.id)
    const sanitized = sanitizeCustomTemplate(previous === undefined ? input : { ...previous, ...input })
    if (sanitized === undefined) {
      throw createError('INVALID_TEMPLATE', '模板需要 1-40 字名称、1-4000 字头部，条数 1-30，字符预算 100-8000；不可变层条目需包含内容')
    }
    if (input.id !== undefined && sanitized.id === undefined) {
      throw createError('INVALID_TEMPLATE_ID', '模板 id 只能使用小写字母、数字、下划线和短横线，且不能与内置模板重名')
    }
    const list = [...(next.prompt.customTemplates ?? [])]
    if (sanitized.id !== undefined) {
      const existing = list.findIndex((template) => template.id === sanitized.id)
      if (existing >= 0) {
        list[existing] = { ...sanitized, id: sanitized.id, custom: true }
      } else {
        const builtin = allTemplates(next).some((template) => template.id === sanitized.id && template.custom !== true)
        if (builtin) throw createError('BUILTIN_TEMPLATE', '内置模板不可覆盖，请使用新的模板 id')
        if (list.length >= 50) throw createError('TEMPLATE_LIMIT', '自定义模板最多 50 个')
        list.push({ ...sanitized, id: sanitized.id, custom: true })
      }
    } else {
      if (list.length >= 50) throw createError('TEMPLATE_LIMIT', '自定义模板最多 50 个')
      const id = `tpl_${randomUUID().slice(0, 8)}`
      list.push({ ...sanitized, id, custom: true })
      sanitized.id = id
    }
    next.prompt.customTemplates = list
    next.prompt.template = sanitized.id
    // 切换模板时关闭预算覆盖，否则新模板的 topN / maxChars 不会生效。
    next.prompt.overrideBudget = false
    current.settings = next
    audit('template.save', `模板 ${sanitized.name}（${sanitized.id}）已保存并切换`, actor)
    await persist()
    return templates()
  }

  async function deleteTemplate(id, actor = 'user') {
    const current = await ensureLoaded()
    const next = normalizeSettings(current.settings)
    const target = allTemplates(next).find((template) => template.id === id)
    if (target === undefined) throw createError('NOT_FOUND', `找不到模板 ${id}`)
    if (target.custom !== true) throw createError('BUILTIN_TEMPLATE', '内置模板不可删除')
    next.prompt.customTemplates = (next.prompt.customTemplates ?? []).filter((template) => template.id !== id)
    if (next.prompt.template === id) next.prompt.template = 'default'
    current.settings = next
    audit('template.delete', `自定义模板 ${target.name}（${id}）已删除`, actor)
    await persist()
    return templates()
  }

  async function applyTemplate(id, actor = 'user') {
    const current = await ensureLoaded()
    const next = normalizeSettings(current.settings)
    const target = allTemplates(next).find((template) => template.id === id)
    if (target === undefined) throw createError('NOT_FOUND', `找不到模板 ${id}`)
    next.prompt.template = id
    next.prompt.overrideBudget = false
    current.settings = next
    audit('template.apply', `已切换到模板 ${target.name}（${id}）`, actor)
    await persist()
    return templates()
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
    diff,
    searchPitfalls,
    recordPitfall,
    checkPitfalls,
    meta: () => currentState().meta,
    injectionStats,
    usageStats,
    templates,
    saveTemplate,
    deleteTemplate,
    applyTemplate,
    consolidationCandidates,
    applyConsolidation,
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
function isExpiredItem(item, now = Date.now()) {
  return item?.expiresAt !== null && item?.expiresAt !== undefined && Date.parse(item.expiresAt) <= now
}

function decorate(item) {
  const info = layerInfo(item.layer)
  return {
    ...item,
    layerName: info.name,
    layerImmutable: info.immutable === true,
    isExpired: isExpiredItem(item),
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
  const now = Date.now()
  return items.filter((item) => {
    if (!layerEnabled(active, item.layer)) return false
    if (layer !== undefined && item.layer !== layer) return false
    if (type !== undefined && item.type !== type) return false
    if (notebook !== undefined && item.notebook !== notebook) return false
    if (status === 'usable') {
      if (item.status !== 'active' && item.status !== 'conflicted') return false
      // 过期但尚未跑 cleanup 的条目不应再被检索/注入。
      if (isExpiredItem(item, now)) return false
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

/** since/until 同时接受 ISO 时间、日期串和毫秒时间戳；非法返回 undefined。 */
function parseTimeOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : undefined
}

function changeSummary(change) {
  const labels = change.changed.length === 0
    ? '无字段变化'
    : change.changed.map((field) => (field === 'content' ? '正文' : field)).join('/')
  return `${change.operation} ${change.entity === 'note' ? '笔记' : '记忆'}「${change.title}」· ${labels}`
}

/** 不含正文的 diff 列表默认只给预览，避免一次返回数百 KB。 */
function trimChangeSnapshot(snapshot, includeContent) {
  if (snapshot === null || snapshot === undefined) return null
  if (includeContent === true || typeof snapshot.content !== 'string' || snapshot.content.length <= 240) return snapshot
  return { ...snapshot, content: `${snapshot.content.slice(0, 240)}…`, contentPreview: true }
}

function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
  return left === right
}

/** 恢复审计行；旧记录没有 kind/change 时保持原样。 */
function normalizeAuditEntry(entry) {
  const base = {
    at: isoOr(entry.at, new Date(0).toISOString()),
    action: truncate(String(entry.action), 60),
    detail: typeof entry.detail === 'string' ? truncate(entry.detail, 400) : '',
    actor: typeof entry.actor === 'string' ? truncate(entry.actor, 40) : 'system',
  }
  if (entry.kind !== 'change' || entry.change === null || typeof entry.change !== 'object') return base
  const change = normalizeChangeRecord(entry.change)
  return change === undefined ? base : { ...base, kind: 'change', change }
}

/** 只接受 diff 需要的显式字段，避免把任意磁盘 JSON 带进前端。 */
function normalizeChangeRecord(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.itemId !== 'string') return undefined
  const changed = Array.isArray(raw.changed)
    ? raw.changed.filter((field) => CHANGE_FIELDS.includes(field)).slice(0, CHANGE_FIELDS.length)
    : []
  return {
    operation: truncate(String(raw.operation ?? 'update'), 30),
    entity: raw.entity === 'note' ? 'note' : 'memory',
    itemId: truncate(raw.itemId, 64),
    title: truncate(String(raw.title ?? ''), 240),
    layer: LAYER_IDS.includes(raw.layer) ? raw.layer : '',
    notebook: NOTEBOOK_IDS.includes(raw.notebook) ? raw.notebook : null,
    changed,
    before: normalizeChangeSnapshot(raw.before),
    after: normalizeChangeSnapshot(raw.after),
    reason: truncate(String(raw.reason ?? ''), 400),
  }
}

function normalizeChangeSnapshot(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const out = {
    id: truncate(String(raw.id ?? ''), 64),
    type: raw.type === 'note' ? 'note' : 'memory',
    version: clampInt(raw.version, 1, Number.MAX_SAFE_INTEGER, 1),
  }
  for (const field of CHANGE_FIELDS) {
    if (!(field in raw)) continue
    if (field === 'content') {
      out.content = truncate(String(raw.content ?? ''), MAX_CHANGE_CONTENT)
      out.contentLength = clampInt(raw.contentLength, 0, Number.MAX_SAFE_INTEGER, out.content.length)
      out.contentTruncated = raw.contentTruncated === true
    } else if (field === 'tags') {
      out.tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string').slice(0, 24) : []
    } else if (field === 'notebook') {
      out.notebook = NOTEBOOK_IDS.includes(raw.notebook) ? raw.notebook : null
    } else if (field === 'title') {
      out.title = truncate(String(raw.title ?? ''), 240)
    } else {
      out[field] = raw[field]
    }
  }
  return out
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
  if (layerInfo(item.layer).immutable) return null
  if (item.ttlDays === null || item.ttlDays === undefined) {
    const info = layerInfo(item.layer)
    if (info.ttl !== true) return null
    const days = Math.max(1, active.maintenance.ttlDays)
    return new Date(Date.now() + days * 86400000).toISOString()
  }
  return new Date(Date.now() + Math.max(1, item.ttlDays) * 86400000).toISOString()
}

function normalizeTtl(value, active, layer) {
  const info = layerInfo(layer)
  if (info.immutable === true) return null
  if (value === null || value === undefined || value === '' || value === 0) {
    // 可修改层必须显式给保鲜期，绝不默认无限期。
    throw createError('TTL_REQUIRED', `写入 ${layer} ${info.name.zh}时必须填写 ttlDays（保鲜期，单位天）`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createError('TTL_REQUIRED', 'ttlDays 必须是大于 0 的天数')
  }
  return Math.max(1, Math.round(parsed))
}

function normalizeLayer(value) {
  if (!LAYER_IDS.includes(value)) throw createError('INVALID_LAYER', `未知分层 ${value}`)
  return value
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
export const TOOL_NAMES = [
  'memory_write',
  'memory_search',
  'memory_get',
  'memory_update',
  'memory_forget',
  'memory_stats',
  'memory_usage',
  'memory_consolidate',
  'memory_pitfall',
  'memory_diff',
]

// 记事本列表在模块初始化后填充（NOTEBOOKS 来自 settings.js）。
import { NOTEBOOKS } from './settings.js'
NOTEBOOK_LIST.push(...NOTEBOOKS)

export { message, getPath }








