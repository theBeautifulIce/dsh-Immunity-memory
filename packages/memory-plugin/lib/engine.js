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
import { readFileSync } from 'node:fs'
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
import { estimateTokens, jaccard, searchableText, tokenize } from './text.js'
import {
  CAPTURE_TRIGGERS,
  captureLabel,
  clipText,
  findNoteDuplicate,
  isDailyDue,
} from './capture.js'

export { jaccard, tokenize }

export const ITEM_TYPES = ['memory', 'note']
export const ITEM_STATUSES = ['active', 'archived', 'expired', 'conflicted']
const PLUGIN_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const MAX_TITLE = 240
const MAX_TAGS = 24
const MAX_TAG_LENGTH = 48
// 「能回答什么问题」：入库时替未来的人写好问法，检索时直接比这句话，
// 不用再从「这条讲什么」翻译回「你会怎么问」。每条最多几句，越短越准。
const MAX_QUESTIONS = 4
const MAX_QUESTION_LENGTH = 120
const MAX_CONTENT = 200000
const DEDUPE_SCAN_LIMIT = 1200
// 变更快照只保留可审阅的字段；正文过长时保留开头并在 UI/API 标记截断。
const MAX_CHANGE_CONTENT = 4000
const MAX_CHANGE_TEXT = 8000
const MAX_CHANGE_AUDIT = 12000
const MAX_KEY = 160
const MAX_SOURCE_QUOTE = 2000
const MAX_SUPERSEDES = 20
const AUDIT_RUN_STATUSES = ['running', 'approved', 'rejected', 'needs_user', 'failed']
const AUDIT_VERDICTS = ['approve', 'reject', 'merge', 'needs_user']
const CHANGE_FIELDS = ['title', 'content', 'layer', 'notebook', 'tags', 'questions', 'importance', 'status', 'pinned', 'ttlDays', 'expiresAt', 'key', 'supersedes', 'supersededBy']

const STATUS_WEIGHT = { active: 1, conflicted: 0.85, archived: 0.6, expired: 0.4 }
// 相关度阈值：低于它只当「背景资料」，不标命中，避免满屏都是命中。
const RELEVANCE_HIT = 0.12
const MIN_HIT_TOKENS = 2
// 一次最多拿多少个查询词参与打分：太多会把 relevance 摊薄，太少又不够区分。
const QUERY_TOKEN_LIMIT = 32
// 查询词里出现得太普遍（超过这个比例）的不算：它们不区分子集。
const QUERY_DF_RATIO = 0.35
// 伪相关反馈开关与参数（见 buildDigest 注释）。
const PRF_ENABLED = true
const PRF_SEED_MIN = 0.25
const PRF_WEIGHT = 0.45
const PRF_TOKEN_LIMIT = 5
// 关系图谱：把「用同一批罕见词讲同一件事」的条目连起来。
// 词面检索救不了换说法，但如果答案那条和某条命中条目共享几个罕见词，
// 从命中条目顺着边爬一步就能把它带进候选。DSH_GRAPH=0 可关掉（跑题库对照用）。
const GRAPH_ENABLED = process.env.DSH_GRAPH !== '0'
// 扫参用：不设环境变量就是下面的默认值。
function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}
const GRAPH_EDGE_MIN = envNumber('DSH_GRAPH_EDGE_MIN', 0.2)
const GRAPH_NEIGHBORS = 3
const GRAPH_SEEDS = envNumber('DSH_GRAPH_SEEDS', 8)
// 0.12 是题库上「@1 不降、@10 略升」的取值；再大就需要更强的边权来兜住，
// 见 ROADMAP 里「关系图谱的实测边界」。
const GRAPH_BONUS = envNumber('DSH_GRAPH_BONUS', 0.12)
const GRAPH_POSTING_MAX = 40
// 注入时的分层：命中条目给全文，靠前的给摘要，其余只留一行线索。
// 三十条平铺六千字，模型真正看进去的只有前几条；把字符预算按相关度分配，
// 同样的 token 数里能装下更多「有用的那一半」。
const HIT_BODY_CHARS = 400
const TOP_BODY_CHARS = 260
const BACKGROUND_BODY_CHARS = 90
const TOP_RANK = 3

/**
 * 查询词里的虚词黑名单：中文按字+二元组切词，不滤掉这些词的话，
 * 「我」「的」「一下」「然后」会跟「灯塔」「叶楠」拿一样的 idf 分量，
 * 把真正有区分度的词淹掉。只过滤查询侧，不影响索引和存储。
 */
const QUERY_STOP_TOKENS = new Set([
  // 单字虚词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '就', '都', '也', '还',
  '着', '过', '吧', '吗', '呢', '啊', '呀', '哦', '嗯', '和', '跟', '给', '把', '被', '有', '没',
  '不', '会', '要', '想', '说', '去', '来', '个', '又', '再', '才', '很', '太', '好', '一', '上',
  '下', '里', '大', '小', '多', '少', '谁', '哪', '啥', '么', '什', '怎', '为', '对', '从', '到',
  // 二元组虚词
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '什么', '怎么', '为什么', '一下',
  '然后', '就是', '还是', '但是', '因为', '所以', '如果', '现在', '已经', '可以', '没有', '不是',
  '知道', '觉得', '样子', '时候', '一个', '这里', '那里', '今天', '昨天', '明天',
  // 英文虚词
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'has', 'was', 'were', 'are', 'you', 'your',
  'what', 'when', 'where', 'how', 'who', 'why', 'did', 'does', 'not', 'but', 'about', 'from',
])

/**
 * 问法和记载说法不一样时的桥：他问「多大」，库里写的是出生年份；
 * 问「全名」，条目里只有名字。这些词表不在索引里，只在查询时加一层同义扩展，
 * 所以不会影响存进去的东西，也不承担「记得对不对」的责任。
 * 只收真正高频、歧义少的对应，不当万能词典用。
 */
const QUERY_EXPANSIONS = new Map([
  ['多大', ['年龄', '岁', '出生', '生日']],
  ['几岁', ['年龄', '岁', '出生']],
  ['年龄', ['岁', '出生', '生日']],
  ['生日', ['出生', '岁', '日期']],
  ['全名', ['名字', '姓名']],
  ['姓名', ['名字', '全名']],
  ['叫什么', ['名字', '姓名']],
  ['哪年', ['年份', '出生', '日期']],
  ['什么时候', ['时间', '日期', '哪天']],
  ['哪天', ['时间', '日期']],
  ['几点', ['时间', '时候']],
  ['多久', ['时间', '时长', '天']],
  ['在哪', ['地点', '地方', '地址']],
  ['哪里', ['地点', '地方', '地址']],
  ['哪儿', ['地点', '地方', '地址']],
  ['地址', ['地点', '地方']],
  ['多少钱', ['价格', '元', '块']],
  ['价格', ['元', '块']],
  ['干什么的', ['工作', '职业']],
  ['做什么', ['工作', '职业']],
  ['谁', ['名字', '姓名']],
])

/**
 * 把查询里能拆开的词换成更可能被写下来的说法。
 * 只加不改：原词全部保留，扩展词仅仅多一次被 df 过滤的机会。
 */
function expandQueryTokens(raw) {
  const expanded = new Set(raw)
  for (const token of raw) {
    const extra = QUERY_EXPANSIONS.get(token)
    if (extra === undefined) continue
    for (const word of extra) expanded.add(word)
  }
  return expanded
}

/** 新建一条记忆/记事本条目。 */
export async function createEngine({ store, getSettings, initialSettings, log, native }) {
  const { createWriteHookRegistry } = await import('./write-hooks.js')
  const writeHooks = createWriteHookRegistry({ log })
  let state
  /** id → item 的索引，检索时避免每次重建 Map。 */
  let itemMap = new Map()
  // 同一个候选的并发 approve/reject 只允许一个进入写库流程。
  const auditDecisionsInFlight = new Set()

  // 当轮上下文：给提示词注入排序用的「现在到底在聊什么」。
  // 只放内存，不落库、不进导出；换会话即重置，超过半小时自然失效。
  // 用户消息和工具报错都算数——踩过的坑往往是先以「报错」的形式回来的。
  const TURN_CONTEXT_ENTRIES = 8
  const TURN_CONTEXT_CHARS = 700
  const TURN_CONTEXT_TTL_MS = 30 * 60 * 1000
  let turnContext = { sessionId: null, entries: [], at: 0 }

  /** 记一条当轮上下文；同一条重复（例如同一个报错连着重试）不入队。 */
  function noteTurnContext(input) {
    const text = truncate(String(input?.text ?? '').replace(/\s+/g, ' ').trim(), TURN_CONTEXT_CHARS)
    if (text === '') return false
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : null
    if (sessionId !== turnContext.sessionId) turnContext = { sessionId, entries: [], at: 0 }
    const last = turnContext.entries[turnContext.entries.length - 1]
    if (last !== undefined && last.text === text) {
      turnContext.at = Date.now()
      return false
    }
    turnContext.entries.push({ text, kind: input?.kind === 'tool' ? 'tool' : 'user' })
    const overflow = turnContext.entries.length - TURN_CONTEXT_ENTRIES
    if (overflow > 0) turnContext.entries.splice(0, overflow)
    turnContext.at = Date.now()
    return true
  }

  /** 当前当轮上下文的文本；为空或过期时返回空串（此时排序退回纯重要度/新近度）。 */
  function turnContextText(now = Date.now()) {
    if (turnContext.entries.length === 0) return ''
    if (now - turnContext.at > TURN_CONTEXT_TTL_MS) return ''
    return turnContext.entries.map((entry) => entry.text).join(' ')
  }

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
    next.meta.audit = normalizeAuditStore(next.meta.audit)
    next.meta.capture = normalizeCaptureStore(next.meta.capture)
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
      } else if (field === 'questions') {
        snapshot.questions = Array.isArray(item.questions) ? item.questions.slice(0, MAX_QUESTIONS) : []
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
        content: typeof item.content === 'string' ? item.content : String(item.content ?? ''),
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
    // 候选状态必须与列表口径一致：列表会把「尚未 propose 过」(state=new) 或
    // 拒绝后又积累了新信号的条目也列出来，这里若只认 state==='candidate'，
    // 用户点「审计通过并固化」就会直接抛 NOT_CANDIDATE，界面看起来像按钮失灵。
    if (records[id]?.state !== 'candidate') {
      const listed = consolidationCandidates({ limit: Math.max(1, active.consolidation.maxCandidates) })
        .some((candidate) => candidate.id === id)
      if (!listed) {
        throw createError('NOT_CANDIDATE', `条目 ${id} 当前不满足固化条件（信号数已过期或重要度过低），请先扫描强化信号`)
      }
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
    const workspace = normalizeWorkspace(options.workspace)
    const started = Date.now()
    // 所有检索出口统一记账：搜索次数、慢查询、最近一次注入的命中情况。
    const finish = (payload) => {
      const tookMs = Date.now() - started
      current.meta.searches = (current.meta.searches ?? 0) + 1
      noteSlowQuery(current, active, {
        at: new Date().toISOString(),
        query: truncate(query, 120),
        tookMs,
        results: payload.items.length,
        path: payload.breakdown,
      })
      noteInjectionHits(current, payload.items)
      return { ...payload, tookMs }
    }

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
      const listed = sorted.map((item) => ({ ...decorate(item), score: round(scoreItem(item, new Set(), active, Date.now())) }))
      return finish({
        items: listed,
        total: scope.length,
        query,
        limit,
        tokens: 0,
        usage: recordUsage('memory_search', options, listed),
        breakdown: 'listing',
      })
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
        if (workspace !== null && item.workspace !== null && item.workspace !== workspace) continue
        if (isExpiredItem(item, started)) continue
        item.accessCount = (item.accessCount ?? 0) + 1
        item.lastAccessAt = new Date().toISOString()
        reinforce(item, 'hit')
        const score = hit.score * forgettingFactor(item, active, started)
        hits.push({ ...decorate(item), score: round(score), breakdown: hit.breakdown })
      }
      hits.sort((left, right) => right.score - left.score)
      if (hits.length > 0) scheduleAccessPersist()
      return finish({
        items: hits,
        total: result.total ?? hits.length,
        query,
        limit,
        tokens: tokenize(query).size,
        usage: recordUsage('memory_search', options, hits),
        weights: result.weights,
        cached: false,
        breakdown: 'go',
      })
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
      if (workspace !== null && item.workspace !== null && item.workspace !== workspace) continue
      if (isExpiredItem(item, started)) continue
      item.accessCount = (item.accessCount ?? 0) + 1
      item.lastAccessAt = new Date().toISOString()
      reinforce(item, 'hit')
      const score = hit.score * forgettingFactor(item, active, started)
      hits.push({ ...decorate(item), score: round(score), breakdown: hit.breakdown })
    }
    hits.sort((left, right) => right.score - left.score)
    if (hits.length > 0) scheduleAccessPersist()
    return finish({
      items: hits,
      total: result.total,
      query,
      limit,
      tokens: tokenize(query).size,
      usage: recordUsage('memory_search', options, hits),
      weights: result.weights,
      cached: result.cached === true,
      breakdown: 'hybrid',
    })
  }

  function getItem(id, workspace) {
    const item = currentState().items.find((candidate) => candidate.id === id)
    if (item === undefined) return undefined
    const scope = normalizeWorkspace(workspace)
    if (scope !== null && item.workspace !== null && item.workspace !== scope) return undefined
    return decorate(item)
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

  async function createItem(input = {}, actor = 'user', options = {}) {
    const beforeHook = options.skipHooks === true
      ? { allowed: true, input }
      : await writeHooks.runBefore({ action: 'create', input, target: null, actor })
    if (beforeHook.allowed === false) {
      throw createError('WRITE_BLOCKED', beforeHook.reason)
    }
    input = beforeHook.input
    const afterCreate = async (item) => {
      if (options.skipHooks !== true) {
        await writeHooks.runAfter({ action: 'create', actor, input, before: null, item })
      }
      return item
    }
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
    assertLayerWritable(active, layer, actor)
    const type = input.type === 'note' ? 'note' : 'memory'
    const notebook = type === 'note' ? normalizeNotebook(input.notebook) : null
    const title = truncate(String(input.title ?? '').trim(), MAX_TITLE) || deriveTitle(input.content, type)
    const content = truncate(String(input.content ?? ''), MAX_CONTENT)
    if (type === 'memory' && content.trim().length < active.write.minContentLength) {
      throw createError('TOO_SHORT', `正文至少需要 ${active.write.minContentLength} 个字符`)
    }
    if (title === '' && content.trim() === '') throw createError('EMPTY', '标题和正文不能同时为空')
    const now = new Date().toISOString()
    const key = normalizeKey(input.key)
    const workspace = normalizeWorkspace(input.workspace)
    const source = normalizeSource({
      kind: actor === 'agent' ? 'agent' : actor === 'import' ? 'import' : 'user',
      sessionId: input.sessionId,
      workspace,
      quote: input.quote ?? input.source?.quote,
      turn: input.turn ?? input.source?.turn,
      confidence: input.confidence ?? input.source?.confidence,
    })
    const supersedes = normalizeIdList(input.supersedes)
    const item = normalizeItem({
      id: newId(),
      type,
      layer,
      notebook,
      title,
      content,
      tags: normalizeTags(input.tags),
      questions: normalizeQuestions(input.questions),
      importance: clampInt(input.importance, 1, 10, active.write.defaultImportance),
      status: 'active',
      pinned: input.pinned === true,
      ttlDays: type === 'memory' ? normalizeTtl(input.ttlDays, active, layer) : null,
      key,
      workspace,
      source,
      supersedes,
      validFrom: now,
      createdAt: now,
      updatedAt: now,
      lastAccessAt: now,
      accessCount: 0,
    })
    if (item === undefined) throw createError('INVALID', '无法创建条目')

    // 实体键是"同一事实"的幂等键：同层同类型同键再次写入时更新原条目，
    // 而不是堆一条新记忆。没有键时仍走内容相似度去重。
    if (key !== null) {
      const existing = current.items.find((candidate) => candidate.key === key
        && candidate.type === type
        && candidate.layer === layer
        && candidate.notebook === notebook
        && candidate.workspace === workspace
        && candidate.supersededBy === null
        && (candidate.status === 'active' || candidate.status === 'conflicted'))
      if (existing !== undefined) {
        const unchanged = existing.title === title && existing.content === content
          && JSON.stringify(existing.tags) === JSON.stringify(item.tags)
          && existing.importance === item.importance
        if (unchanged && supersedes.length === 0) {
          existing.source = normalizeSource({
            kind: source.kind,
            sessionId: source.sessionId ?? existing.source?.sessionId,
            workspace: source.workspace ?? existing.source?.workspace,
            quote: source.quote ?? existing.source?.quote,
            turn: source.turn ?? existing.source?.turn,
            confidence: source.confidence ?? existing.source?.confidence,
          })
          // 同键同内容再写一次也是一次“续期”：必须刷新保鲜期，
          // 不能让旧到期时间继续生效，更不能变成无限保鲜。
          existing.ttlDays = item.ttlDays
          existing.expiresAt = expiresAtFor(existing, active)
          existing.updatedAt = now
          existing.lastAccessAt = now
          existing.accessCount = (existing.accessCount ?? 0) + 1
          reinforce(existing, 'create')
          indexItem(existing)
          await persist()
          return afterCreate(decorate(existing))
        }
        const beforeExisting = clone(existing)
        const updated = await updateItem(existing.id, {
          title,
          content,
          tags: item.tags,
          importance: item.importance,
          ttlDays: type === 'memory' ? item.ttlDays : null,
          key,
          quote: source.quote,
          turn: source.turn,
          confidence: source.confidence,
          supersedes,
        }, actor, { skipHooks: true })
        if (options.skipHooks !== true) {
          await writeHooks.runAfter({ action: 'update', actor, input, before: beforeExisting, item: updated })
        }
        return updated
      }
    }

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
    if (supersedes.length > 0) applySupersedes(current, item, supersedes, actor, now)
    detectConflicts(current, item, active)
    audit('create', `${item.layer}/${item.type} ${item.title}`, actor)
    recordChange('create', null, item, actor)
    current.meta.writes = (current.meta.writes ?? 0) + 1
    await persist()
    return afterCreate(decorate(item))
  }

  async function updateItem(id, patch = {}, actor = 'user', options = {}) {
    const current = await ensureLoaded()
    const active = settings()
    const index = current.items.findIndex((candidate) => candidate.id === id)
    if (index < 0) throw createError('NOT_FOUND', `找不到条目 ${id}`)
    const before = current.items[index]
    const beforeChange = clone(before)
    const beforeHook = options.skipHooks === true
      ? { allowed: true, input: patch }
      : await writeHooks.runBefore({ action: 'update', input: patch, target: clone(before), actor })
    if (beforeHook.allowed === false) {
      throw createError('WRITE_BLOCKED', beforeHook.reason)
    }
    patch = beforeHook.input
    assertLayerWritable(active, before.layer, actor)
    const next = { ...before }
    if (patch.title !== undefined) next.title = truncate(String(patch.title).trim(), MAX_TITLE) || before.title
    if (patch.content !== undefined) next.content = truncate(String(patch.content), MAX_CONTENT)
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags)
    if (patch.questions !== undefined) next.questions = normalizeQuestions(patch.questions)
    if (patch.importance !== undefined) next.importance = clampInt(patch.importance, 1, 10, before.importance)
    if (patch.layer !== undefined) {
      const layer = normalizeLayer(patch.layer)
      assertLayerWritable(active, layer, actor)
      next.layer = layer
      // 不可变层不允许携带保鲜期，移入时一并清掉。
      if (layerInfo(layer).immutable) next.ttlDays = null
    }
    if (patch.notebook !== undefined && next.type === 'note') next.notebook = normalizeNotebook(patch.notebook)
    if (patch.pinned !== undefined) next.pinned = patch.pinned === true
    if (patch.workspace !== undefined) {
      next.workspace = normalizeWorkspace(patch.workspace)
      next.source = normalizeSource({ ...before.source, workspace: next.workspace })
    }
    if (patch.status !== undefined) {
      if (!ITEM_STATUSES.includes(patch.status)) throw createError('INVALID_STATUS', `未知状态 ${patch.status}`)
      next.status = patch.status
    }
    if (patch.ttlDays !== undefined) next.ttlDays = normalizeTtl(patch.ttlDays, active, next.layer)
    if (patch.key !== undefined) {
      const nextKey = normalizeKey(patch.key)
      if (nextKey !== null) {
        const clash = current.items.find((candidate) => candidate.id !== id
          && candidate.key === nextKey
          && candidate.type === next.type
          && candidate.layer === next.layer
          && candidate.notebook === next.notebook
          && candidate.workspace === next.workspace
          && candidate.status === 'active'
          && candidate.supersededBy === null)
        if (clash !== undefined) throw createError('KEY_CONFLICT', `实体键 ${nextKey} 已被 ${clash.id} 占用`)
      }
      next.key = nextKey
    }
    if (patch.quote !== undefined || patch.turn !== undefined || patch.confidence !== undefined || patch.source !== undefined) {
      next.source = normalizeSource({
        ...before.source,
        ...(patch.source !== null && typeof patch.source === 'object' ? patch.source : {}),
        quote: patch.quote ?? patch.source?.quote ?? before.source?.quote,
        turn: patch.turn ?? patch.source?.turn ?? before.source?.turn,
        confidence: patch.confidence ?? patch.source?.confidence ?? before.source?.confidence,
      })
    }
    if (patch.supersedes !== undefined) next.supersedes = normalizeIdList(patch.supersedes)
    if (patch.title === undefined && patch.content === undefined && patch.tags === undefined
      && patch.questions === undefined
      && patch.importance === undefined && patch.layer === undefined && patch.pinned === undefined
      && patch.workspace === undefined
      && patch.status === undefined && patch.ttlDays === undefined && patch.notebook === undefined
      && patch.key === undefined && patch.quote === undefined && patch.turn === undefined
      && patch.confidence === undefined && patch.source === undefined && patch.supersedes === undefined) {
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
    if (Array.isArray(current.items[index].supersedes) && current.items[index].supersedes.length > 0) {
      applySupersedes(current, current.items[index], current.items[index].supersedes, actor, next.updatedAt)
    }
    detectConflicts(current, current.items[index], active)
    audit('update', `${current.items[index].layer}/${current.items[index].title}`, actor)
    recordChange('update', beforeChange, current.items[index], actor)
    await persist()
    const updated = decorate(current.items[index])
    if (options.skipHooks !== true) {
      await writeHooks.runAfter({ action: 'update', actor, input: patch, before: beforeChange, item: updated })
    }
    return updated
  }

  /** 把被取代的旧条目归档，并写入双向链接；不可变层不参与自动归档。 */
  function applySupersedes(current, item, ids, actor, at) {
    const wanted = new Set(ids.filter((id) => typeof id === 'string' && id !== item.id))
    if (wanted.size === 0) return
    for (const target of current.items) {
      if (!wanted.has(target.id)) continue
      if (layerInfo(target.layer).immutable) continue
      if (target.supersededBy === item.id) continue
      const before = clone(target)
      target.status = 'archived'
      target.supersededBy = item.id
      target.validTo = at
      target.updatedAt = at
      target.version = (target.version ?? 1) + 1
      indexItem(target)
      recordChange('supersede', before, target, actor, { reason: `被 ${item.id} 取代` })
      audit('supersede', `${target.id} 被 ${item.id} 取代`, actor)
    }
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
      if (layerInfo(item.layer).immutable && actor !== 'user' && !active.write.allowImmutableEdit) {
        log('warn', `拒绝删除不可变分层的条目 ${item.id}（${item.layer}）：仅用户可在面板里删除`)
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
      if (layerInfo(item.layer).immutable && actor !== 'user' && !active.write.allowImmutableEdit) continue
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
    // 维护面板的历史表：只保留轻量摘要，不重复存整份候选列表。
    const history = Array.isArray(current.meta.maintenanceRuns) ? current.meta.maintenanceRuns : []
    history.push({
      ranAt: report.ranAt,
      tasks: report.tasks.map((entry) => ({
        task: entry.task,
        changed: entry.changed ?? 0,
        note: truncate(String(entry.note ?? ''), 200),
      })),
      totals: {
        total: report.totals?.total ?? 0,
        active: report.totals?.byStatus?.active ?? 0,
        conflicted: report.totals?.byStatus?.conflicted ?? 0,
      },
    })
    current.meta.maintenanceRuns = history.slice(-clampInt(active.maintenance.historyKeep, 1, 200, 20))
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
      if (candidate.workspace !== item.workspace) continue
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
      if (other.workspace !== item.workspace) continue
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
   * 解决一条冲突：保留一侧，或把两侧正文合并成一条。
   * 这是显式人工动作，不会自动改写；败者归档并写 supersededBy，保留完整审计。
   */
  async function resolveConflict(input = {}, actor = 'user') {
    const hook = await writeHooks.runBefore({
      action: 'conflict.resolve',
      input,
      target: null,
      actor,
    })
    if (hook.allowed === false) throw createError('WRITE_BLOCKED', hook.reason)
    input = hook.input
    const current = await ensureLoaded()
    const active = settings()
    assertEnabled(active)
    const winnerId = String(input.winnerId ?? input.leftId ?? '')
    const loserId = String(input.loserId ?? input.rightId ?? '')
    if (winnerId === '' || loserId === '' || winnerId === loserId) {
      throw createError('INVALID_CONFLICT', '需要两个不同的条目 id')
    }
    const winner = current.items.find((item) => item.id === winnerId)
    const loser = current.items.find((item) => item.id === loserId)
    if (winner === undefined || loser === undefined) throw createError('NOT_FOUND', '冲突条目不存在')
    if (winner.type !== loser.type) throw createError('INVALID_CONFLICT', '不同类型不能合并')
    if (!layerInfo(winner.layer).conflictable || !layerInfo(loser.layer).conflictable) {
      throw createError('INVALID_CONFLICT', '只有可冲突层支持合并')
    }
    if (winner.layer !== loser.layer || winner.workspace !== loser.workspace) {
      throw createError('INVALID_CONFLICT', '只有同层同项目的条目可以解决冲突')
    }
    const strategy = input.strategy === 'merge' ? 'merge' : 'keep'
    const now = new Date().toISOString()
    const beforeWinner = clone(winner)
    const beforeLoser = clone(loser)
    if (strategy === 'merge') {
      if (winner.type === 'memory') {
        winner.ttlDays = normalizeTtl(input.ttlDays ?? winner.ttlDays, active, winner.layer)
        winner.expiresAt = expiresAtFor(winner, active)
      }
      winner.title = truncate(String(input.title ?? winner.title), MAX_TITLE) || winner.title
      winner.content = truncate(String(input.content ?? `${winner.content}\n\n---\n\n${loser.content}`), MAX_CONTENT)
      winner.tags = normalizeTags([...(winner.tags ?? []), ...(loser.tags ?? []), ...(Array.isArray(input.tags) ? input.tags : [])])
      winner.version = (winner.version ?? 1) + 1
      winner.updatedAt = now
      recordChange('conflict.merge', beforeWinner, winner, actor, { reason: `合并 ${loser.id}` })
    }
    winner.status = 'active'
    winner.conflicts = (winner.conflicts ?? []).filter((id) => id !== loser.id)
    winner.supersedes = normalizeIdList([...(winner.supersedes ?? []), loser.id])
    loser.status = 'archived'
    loser.supersededBy = winner.id
    loser.validTo = now
    loser.updatedAt = now
    loser.version = (loser.version ?? 1) + 1
    loser.conflicts = (loser.conflicts ?? []).filter((id) => id !== winner.id)
    recordChange('conflict.resolve', beforeLoser, loser, actor, { reason: `由 ${winner.id} 保留` })
    reinforce(winner, 'update')
    reindexAll()
    audit('conflict.resolve', `${strategy} ${winner.title} ← ${loser.title}`, actor)
    await persist()
    const resolved = { strategy, winner: decorate(winner), loser: decorate(loser) }
    await writeHooks.runAfter({
      action: 'conflict.resolve',
      actor,
      input,
      before: { winner: beforeWinner, loser: beforeLoser },
      item: resolved.winner,
      result: resolved,
    })
    return resolved
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
      if (left.workspace !== right.workspace) continue
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

  /** 健康分、慢查询、维护历史与最近一次注入命中率。 */
  function diagnostics() {
    return diagnosticsSnapshot(currentState(), settings())
  }

  function status() {
    const current = currentState()
    const active = settings()
    return {
      version: STORE_VERSION,
      pluginVersion: PLUGIN_VERSION,
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
    const hook = await writeHooks.runBefore({
      action: 'import',
      input: { payload, mode },
      target: null,
      actor: 'user',
    })
    if (hook.allowed === false) throw createError('WRITE_BLOCKED', hook.reason)
    payload = hook.input.payload
    mode = hook.input.mode === 'replace' ? 'replace' : 'merge'
    const originalPayload = payload
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
    const summary = { imported: imported.length, skipped, ttlFilled, mode }
    await writeHooks.runAfter({
      action: 'import',
      actor: 'user',
      input: { payload: originalPayload, mode },
      before: null,
      item: null,
      summary,
    })
    return summary
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
  function buildDigest(now = Date.now(), workspace = undefined, options = {}) {
    const current = currentState()
    const active = settings()
    const template = activeTemplate(active)
    const budget = promptBudget(active)
    const enabled = active.enabled !== false && active.prompt.inject !== false && budget.topN > 0
    // 当轮上下文 → 查询词：让注入跟着「现在在干什么」走，而不是永远按重要度排。
    const queryText = typeof options.query === 'string' && options.query !== ''
      ? options.query
      : turnContextText(now)
    const empty = {
      enabled,
      text: '',
      preview: '',
      tokens: 0,
      chars: 0,
      topN: budget.topN,
      maxChars: budget.maxChars,
      truncated: false,
      query: { used: false, tokens: 0, chars: queryText.length, preview: truncate(queryText, 160), hitBar: RELEVANCE_HIT },
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
      if (item.duplicateOf !== null && item.duplicateOf !== undefined) return false
      if (item.supersededBy !== null && item.supersededBy !== undefined) return false
      if (isExpiredItem(item, now)) return false
      if (!layerEnabled(active, item.layer)) return false
      if (workspace !== undefined && item.workspace !== null && item.workspace !== workspace) return false
      if (item.type !== 'memory') return false
      // 模板已经提供不可变层时，以模板为准，避免数据库里的旧同层条目重复注入。
      if (configuredImmutable && layerInfo(item.layer).immutable) return false
      return true
    })
    const queryTokens = selectQueryTokens(queryText, candidates)
    const stats = queryTokens.size > 0 ? corpusStats(candidates) : undefined
    const scored = candidates.map((item) => ({
      item,
      relevance: queryRelevance(item, queryTokens, stats),
      matched: matchedQueryTokens(item, queryTokens),
      score: scoreItem(item, queryTokens, active, now, stats),
    }))
    // 伪相关反馈：先用原查询排一遍，把最像的那条里的罕见词当作「用户其实想找的东西」
    // 再加回查询里。同义、换说法造成的缺口，靠这一层能拉回一部分，不用上向量。
    if (PRF_ENABLED && stats !== undefined && scored.length > 1) {
      const seed = [...scored].sort((left, right) => right.relevance - left.relevance)[0]
      if (seed !== undefined && seed.relevance >= PRF_SEED_MIN) {
        const extra = feedbackTokens(seed.item, queryTokens, stats)
        if (extra.size > 0) {
          const expanded = new Set([...queryTokens, ...extra])
          for (const entry of scored) {
            // 排序用扩展后的分；「命中」标记仍然只看原查询，
            // 不然反馈词会把一堆条目抬到同一档，标记就分不出高低了。
            entry.relevanceRaw = entry.relevance
            entry.relevance = queryRelevance(entry.item, expanded, stats)
            entry.score = scoreItem(entry.item, expanded, active, now, stats)
          }
        }
      }
    }
    // 关系图谱：词面没救的条目，如果跟最相关那几条讲的是同一件事，顺着边抬进来。
    if (GRAPH_ENABLED && active.retrieval?.graph !== false) {
      applyGraphBonus(scored, graphEdgeIndex(candidates, stats))
    }
    // 命中门槛不能只看绝对值：一句无关的话也可能碰上一两个通用词，
    // 于是「每条都标命中」。用候选集自身的中位数当背景，只有明显高于背景的才算命中。
    const hitBar = relevanceBar(scored.map((entry) => entry.relevanceRaw ?? entry.relevance))
    scored.sort((left, right) => {
      if (Math.abs(right.score - left.score) > 1e-9) return right.score - left.score
      // 分不出高下时，新记得的那条优先：同一个话题后说的通常才是现行版本。
      const newer = Date.parse(right.item.updatedAt ?? '') - Date.parse(left.item.updatedAt ?? '')
      if (Number.isFinite(newer) && newer !== 0) return newer
      return 0
    })
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
    let rank = -1
    for (const { item, relevance, relevanceRaw, matched } of chosen) {
      rank += 1
      // 命中标记：让模型一眼看出哪几条是「跟这一轮有关」，而不是又一份需要通读的背景资料。
      // 只沾上一个词不算——短查询里一个通用词就能拿到 0.5 的相对分，所以要求至少对上两个词。
      const hit = (relevanceRaw ?? relevance) >= hitBar && matched >= MIN_HIT_TOKENS
      const limit = hit ? HIT_BODY_CHARS : rank < TOP_RANK ? TOP_BODY_CHARS : BACKGROUND_BODY_CHARS
      const body = truncate(item.content.replace(/\s+/g, ' ').trim(), limit)
      const mark = hit ? '·命中' : ''
      lines.push(`- [${item.layer}·重要度${item.importance}${mark}] ${item.title}：${body}`)
      lineMeta.push({ id: item.id, title: item.title, layer: item.layer, importance: item.importance, source: 'memory', relevance: relevanceRaw ?? relevance, matched })
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
        relevance: entry.relevance ?? null,
        matched: entry.matched ?? null,
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
      query: {
        used: queryTokens.size > 0,
        tokens: queryTokens.size,
        chars: queryText.length,
        preview: truncate(queryText, 160),
        hitBar: Number.isFinite(hitBar) ? Math.round(hitBar * 1000) / 1000 : null,
      },
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
  function promptDigest(now = Date.now(), workspace = null, options = {}) {
    const built = buildDigest(now, normalizeWorkspace(workspace), options)
    noteInjection(currentState(), built.lines.filter((line) => line.source === 'memory').map((line) => line.id))
    return built.text
  }

  /** 注入预算明细（UI 与 API 用）。 */
  function injectionStats(now = Date.now(), workspace = undefined, options = {}) {
    return buildDigest(now, workspace === undefined ? undefined : normalizeWorkspace(workspace), options)
  }

  // ------------------------------------------------------------ 自动记忆 ----

  function captureState(current) {
    if (current.meta.capture === null || typeof current.meta.capture !== 'object') {
      current.meta.capture = normalizeCaptureStore(null)
    }
    return current.meta.capture
  }

  /**
   * 记录一条即时信号。这里只入队，不写记忆；真正提取事实由智能体在
   * memory_capture 里决定，避免插件替模型猜测该记什么。
   */
  async function noteCaptureSignal(signal = {}) {
    const current = await ensureLoaded()
    const active = settings()
    if (active.autoCapture.enabled !== true || active.autoCapture.immediate !== true) {
      return { queued: false, reason: 'disabled' }
    }
    const trigger = CAPTURE_TRIGGERS.includes(signal.trigger) ? signal.trigger : 'manual'
    if (trigger === 'small_review' || trigger === 'large_review') {
      throw createError('INVALID_CAPTURE_TRIGGER', '即时信号不能使用回顾触发器')
    }
    const capture = captureState(current)
    const sessionId = typeof signal.sessionId === 'string' ? truncate(signal.sessionId, 120) : null
    const turn = Number.isFinite(Number(signal.turn)) ? Number(signal.turn) : null
    const text = clipText(String(signal.text ?? ''), 2000)
    const duplicate = capture.pending.find((entry) => entry.trigger === trigger
      && entry.sessionId === sessionId && entry.turn === turn
      && (turn !== null || entry.text === text))
    if (duplicate !== undefined) return { queued: false, duplicate: true, entry: duplicate }
    const entry = {
      id: `cap_${randomUUID().slice(0, 8)}`,
      trigger,
      reason: clipText(String(signal.reason ?? captureLabel(trigger)), 200),
      at: new Date().toISOString(),
      sessionId,
      turn,
      text,
    }
    capture.pending.push(entry)
    capture.pending = capture.pending.slice(-clampInt(active.autoCapture.queueKeep, 1, 100, 20))
    capture.lastSignalAt = entry.at
    await persist()
    return { queued: true, entry }
  }

  /**
   * 小/大定时只负责排队。第一次 tick 只记起点，不立即回顾，避免刚安装就
   * 触发一次昂贵回顾；之后按设置间隔/每日时刻入队。
   */
  async function tickCapture(now = Date.now()) {
    const current = await ensureLoaded()
    const active = settings()
    const cfg = active.autoCapture
    if (cfg.enabled !== true) return { queued: [] }
    const capture = captureState(current)
    const queued = []
    const isoNow = new Date(now).toISOString()
    if (cfg.smallEnabled === true) {
      if (capture.lastSmallQueuedAt === null || capture.lastSmallQueuedAt === undefined) {
        capture.lastSmallQueuedAt = isoNow
      } else if (!capture.pending.some((entry) => entry.trigger === 'small_review')) {
        const gap = now - Date.parse(capture.lastSmallQueuedAt)
        if (Number.isFinite(gap) && gap >= clampInt(cfg.smallIntervalHours, 1, 168, 4) * 3600000) {
          const since = capture.lastSmallReviewAt ?? new Date(now - clampInt(cfg.smallWindowHours, 1, 168, 4) * 3600000).toISOString()
          const entry = {
            id: `cap_${randomUUID().slice(0, 8)}`,
            trigger: 'small_review',
            reason: '小时回顾',
            at: isoNow,
            sessionId: null,
            turn: null,
            text: '',
            since,
            until: isoNow,
          }
          capture.pending.push(entry)
          capture.lastSmallQueuedAt = isoNow
          queued.push(entry)
        }
      }
    }
    if (cfg.largeEnabled === true) {
      if (capture.lastLargeQueuedAt === null || capture.lastLargeQueuedAt === undefined) {
        capture.lastLargeQueuedAt = isoNow
      } else if (!capture.pending.some((entry) => entry.trigger === 'large_review')
        && isDailyDue(now, cfg.largeAt, capture.lastLargeQueuedAt)) {
        const since = capture.lastLargeReviewAt
          ?? new Date(now - clampInt(cfg.largeLookbackDays, 1, 365, 7) * 86400000).toISOString()
        const entry = {
          id: `cap_${randomUUID().slice(0, 8)}`,
          trigger: 'large_review',
          reason: '每日回顾',
          at: isoNow,
          sessionId: null,
          turn: null,
          text: '',
          since,
          until: isoNow,
        }
        capture.pending.push(entry)
        capture.lastLargeQueuedAt = isoNow
        queued.push(entry)
      }
    }
    if (queued.length > 0) {
      capture.pending = capture.pending.slice(-clampInt(cfg.queueKeep, 1, 100, 20))
      await persist()
    }
    return { queued }
  }

  /** 提示词里的自动记忆提醒：常驻一行规则，有队列时展开。 */
  function capturePrompt(now = Date.now()) {
    const current = currentState()
    const active = settings()
    if (active.autoCapture.enabled !== true) return ''
    const capture = captureState(current)
    const lines = [
      '【自动记忆】当用户纠正你、要求你记住、表达明显满意/不满，或你自己发现答错时，调用 memory_capture。'
      + '事实写到哪一层、TTL 多长由你按内容判断；若这次判断形成了可复用的规则，把它作为 L4 学习层记忆写入。'
      + '笔记由代码按记事本去重。',
      '【能回答什么问题】每条记忆顺手写一句 questions：用他当时问法或下次会问的说法写（例如“怎么才能不把钱花超”），'
      + '只从原话与事实里抽，不要照着答案反推、不要写成标签。这句话检索时等价于第二个标题，写好了下次才找得到。',
    ]
    const pending = capture.pending.slice(-5)
    if (pending.length > 0) {
      lines.push('待处理信号：')
      for (const entry of pending) {
        const scope = typeof entry.since === 'string' && typeof entry.until === 'string'
          ? `（${entry.since.slice(0, 10)} 至 ${entry.until.slice(0, 10)}）`
          : ''
        const excerpt = entry.text === '' ? entry.reason : clipText(entry.text.replace(/\s+/g, ' '), 140)
        lines.push(`- [${entry.id}] ${captureLabel(entry.trigger, 'zh')}${scope}：${excerpt}`)
      }
      lines.push('回顾后用 memory_capture 提交事实/笔记，并传 pendingId 清除对应信号；没有可记的就传 outcome:"nothing"。')
    }
    const dueSmall = active.autoCapture.smallEnabled === true && capture.pending.some((entry) => entry.trigger === 'small_review')
    const dueLarge = active.autoCapture.largeEnabled === true && capture.pending.some((entry) => entry.trigger === 'large_review')
    if (dueSmall) lines.push('小时回顾：先用 memory_diff/memory_search 看窗口内的变化，再决定写入什么。')
    if (dueLarge) lines.push('每日回顾：总结近期表现与反复出现的问题；值得长期保留的再写入 L4/L5。')
    return lines.join('\n')
  }

  /**
   * 智能体显式提交捕获结果。事实必须自带 layer 与 TTL（可修改层），
   * 笔记只做代码去重；插件不会在这里替模型补内容或猜触发原因。
   */
  async function capture(input = {}, actor = 'agent') {
    const current = await ensureLoaded()
    const active = settings()
    if (active.autoCapture.enabled !== true) {
      throw createError('CAPTURE_DISABLED', '自动记忆已在设置中关闭')
    }
    const trigger = CAPTURE_TRIGGERS.includes(input.trigger) ? input.trigger : 'manual'
    const maxFacts = clampInt(active.autoCapture.maxFacts, 1, 20, 6)
    const maxNotes = clampInt(active.autoCapture.maxNotes, 1, 20, 6)
    const facts = Array.isArray(input.facts) ? input.facts.slice(0, maxFacts) : []
    const notes = Array.isArray(input.notes) ? input.notes.slice(0, maxNotes) : []
    const capture = captureState(current)
    const now = new Date().toISOString()
    const sessionId = typeof input.sessionId === 'string' ? truncate(input.sessionId, 120) : null
    const turn = Number.isFinite(Number(input.turn)) ? Number(input.turn) : null
    const created = []
    const updated = []
    const skipped = []
    const errors = []
    const threshold = clampNumber(active.autoCapture.noteDedupe, 0.5, 1, 0.92)
    const workspace = normalizeWorkspace(input.workspace)

    for (const fact of facts) {
      if (fact === null || typeof fact !== 'object') {
        errors.push({ kind: 'fact', reason: '条目不是对象' })
        continue
      }
      try {
        const item = await createItem({
          type: 'memory',
          layer: fact.layer,
          title: fact.title,
          content: fact.content,
          ttlDays: fact.ttlDays,
          tags: fact.tags,
          questions: fact.questions,
          importance: fact.importance,
          key: fact.key,
          workspace: fact.workspace ?? workspace,
          quote: fact.reason ?? fact.quote,
          sessionId,
          turn,
        }, actor)
        created.push({ kind: 'fact', id: item.id, layer: item.layer, title: item.title })
      } catch (error) {
        errors.push({ kind: 'fact', title: clipText(fact.title ?? '', 80), error: message(error), code: error?.code ?? null })
      }
    }

    for (const note of notes) {
      if (note === null || typeof note !== 'object') {
        errors.push({ kind: 'note', reason: '条目不是对象' })
        continue
      }
      const content = String(note.content ?? '')
      if (content.trim() === '') {
        errors.push({ kind: 'note', title: clipText(note.title ?? '', 80), reason: '正文为空' })
        continue
      }
      const duplicate = findNoteDuplicate(current.items, {
        notebook: note.notebook,
        content,
      }, threshold)
      if (duplicate !== undefined) {
        duplicate.item.updatedAt = now
        duplicate.item.lastAccessAt = now
        duplicate.item.accessCount = (duplicate.item.accessCount ?? 0) + 1
        indexItem(duplicate.item)
        skipped.push({ kind: 'note', reason: duplicate.exact ? 'exact-duplicate' : 'similar-duplicate', id: duplicate.item.id, score: round(duplicate.score) })
        continue
      }
      try {
        const item = await createItem({
          type: 'note',
          layer: 'L4',
          notebook: note.notebook,
          title: note.title,
          content,
          tags: note.tags,
          questions: note.questions,
          importance: note.importance,
          workspace: note.workspace ?? workspace,
          quote: note.reason ?? note.quote,
          sessionId,
          turn,
        }, actor)
        created.push({ kind: 'note', id: item.id, layer: item.layer, title: item.title, notebook: item.notebook })
      } catch (error) {
        errors.push({ kind: 'note', title: clipText(note.title ?? '', 80), error: message(error), code: error?.code ?? null })
      }
    }

    if (skipped.length > 0) {
      // 去重命中也要落盘，否则 accessCount/updatedAt 只改了内存。
      await persist()
    }

    const run = {
      id: `cap_${randomUUID().slice(0, 8)}`,
      trigger,
      at: now,
      actor,
      sessionId,
      turn,
      summary: clipText(String(input.summary ?? ''), 2000),
      created,
      updated,
      skipped,
      errors,
    }
    capture.runs.push(run)
    capture.runs = capture.runs.slice(-50)
    if (trigger === 'small_review') capture.lastSmallReviewAt = now
    if (trigger === 'large_review') capture.lastLargeReviewAt = now
    capture.pending = capture.pending.filter((entry) => {
      if (typeof input.pendingId === 'string' && input.pendingId !== '') return entry.id !== input.pendingId
      if (entry.trigger !== trigger) return true
      return false
    })
    audit('capture', `自动记忆 ${captureLabel(trigger, 'zh')}：新建 ${created.length}，跳过 ${skipped.length}，失败 ${errors.length}`, actor)
    await persist()
    return {
      run: { ...run, pending: capture.pending.length },
      created,
      updated,
      skipped,
      errors,
      pending: capture.pending.length,
    }
  }

  function captureStats() {
    const current = currentState()
    const capture = captureState(current)
    return {
      enabled: settings().autoCapture.enabled === true,
      pending: capture.pending.length,
      runs: capture.runs.length,
      lastSignalAt: capture.lastSignalAt ?? null,
      lastSmallReviewAt: capture.lastSmallReviewAt ?? null,
      lastLargeReviewAt: capture.lastLargeReviewAt ?? null,
      recent: capture.runs.slice(-5).reverse().map((run) => ({
        id: run.id,
        trigger: run.trigger,
        at: run.at,
        created: run.created.length,
        skipped: run.skipped.length,
        errors: run.errors.length,
        summary: run.summary,
      })),
    }
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

  // ------------------------------------------------------------ 审计 Hook ----

  function auditStore() {
    const current = currentState()
    if (current.meta.audit === undefined) current.meta.audit = normalizeAuditStore(undefined)
    current.meta.audit = normalizeAuditStore(current.meta.audit)
    return current.meta.audit
  }

  function auditStats() {
    const bucket = auditStore()
    const active = settings()
    const tokens = emptyUsage()
    const counts = { running: 0, approved: 0, rejected: 0, needs_user: 0, failed: 0 }
    for (const run of bucket.runs) {
      counts[run.status] = (counts[run.status] ?? 0) + 1
      addUsage(tokens, run.usage)
    }
    return {
      enabled: active.hook?.enabled === true,
      enforce: active.hook?.enforce !== false,
      minConfidence: active.hook?.minConfidence ?? 0.7,
      total: bucket.runs.length,
      ...counts,
      blocked: bucket.runs.filter((run) => (run.status === 'rejected' || run.status === 'needs_user') && run.enforced === true).length,
      needsUser: counts.needs_user,
      pending: bucket.runs.filter((run) => run.enforced === true && !run.decision && (run.status === 'needs_user' || run.status === 'rejected')).length,
      tokens: {
        input: tokens.inputTokens,
        output: tokens.outputTokens,
        cacheRead: tokens.cacheReadTokens,
        cacheWrite: tokens.cacheWriteTokens,
        total: tokens.totalTokens,
      },
      lastAt: bucket.runs.length > 0 ? bucket.runs[bucket.runs.length - 1].at : null,
    }
  }

  function auditRuns(options = {}) {
    const status = AUDIT_RUN_STATUSES.includes(options.status) ? options.status : undefined
    const limit = clampInt(options.limit, 1, 500, 50)
    return auditStore().runs
      .filter((run) => status === undefined || run.status === status)
      .slice(-limit)
      .reverse()
  }

  async function recordAuditRun(input = {}) {
    const current = await ensureLoaded()
    const bucket = auditStore()
    const run = normalizeAuditRun({ ...input, id: input.id ?? `audit_${randomUUID().slice(0, 12)}`, at: input.at ?? new Date().toISOString() })
    bucket.runs.push(run)
    const cap = Math.max(10, settings().hook?.maxRuns ?? 100)
    if (bucket.runs.length > cap) bucket.runs = bucket.runs.slice(-cap)
    current.meta.audit = bucket
    await persist()
    return clone(run)
  }

  async function finishAuditRun(id, patch = {}) {
    const current = await ensureLoaded()
    const bucket = auditStore()
    const run = bucket.runs.find((candidate) => candidate.id === id)
    if (run === undefined) throw createError('AUDIT_NOT_FOUND', `找不到审计记录 ${id}`)
    const merged = normalizeAuditRun({
      ...run,
      ...patch,
      usage: patch.usage !== undefined ? patch.usage : run.usage,
      finishedAt: patch.finishedAt ?? new Date().toISOString(),
      durationMs: patch.durationMs ?? Math.max(0, Date.now() - Date.parse(run.startedAt ?? run.at)),
    })
    Object.assign(run, merged)
    current.meta.audit = bucket
    await persist()
    return clone(run)
  }

  async function decideAuditRun(id, decision, note = '', actor = 'user') {
    if (auditDecisionsInFlight.has(id)) {
      throw createError('AUDIT_BUSY', '该审计候选正在处理，请稍后再试')
    }
    auditDecisionsInFlight.add(id)
    try {
      const current = await ensureLoaded()
    if (decision !== 'approve' && decision !== 'reject') throw createError('INVALID_DECISION', 'decision 必须是 approve 或 reject')
    const bucket = auditStore()
    const run = bucket.runs.find((candidate) => candidate.id === id)
    if (run === undefined) throw createError('AUDIT_NOT_FOUND', `找不到审计记录 ${id}`)
    const at = new Date().toISOString()
    const pending = run.enforced === true && (run.status === 'needs_user' || run.status === 'rejected')

    // 候选队列语义：被拦截的写入还没有落库。人工批准时用审计记录里的
    // proposed 载荷补写，并记录 appliedItemId，避免重复点击生成多条记录。
    if (decision === 'approve' && pending && run.appliedItemId === null) {
      try {
        let applied
        const patch = {
          ...(run.proposed ?? {}),
          sessionId: run.sessionId ?? undefined,
          quote: run.sourceQuote ?? undefined,
          source: {
            kind: 'agent',
            sessionId: run.sessionId ?? undefined,
            quote: run.sourceQuote ?? undefined,
          },
        }
        if (run.action === 'update' && typeof run.targetId === 'string') {
          const existing = current.items.find((candidate) => candidate.id === run.targetId)
          if (existing !== undefined) {
            applied = await updateItem(run.targetId, patch, actor)
          }
        }
        if (applied === undefined) {
          // 崩溃恢复：createItem 会先持久化条目，appliedItemId 要到最后才持久化；
          // 没有 key 时用完整正文 + 层级 + 会话定位刚写入的那一条，避免重试再建一条。
          const wantedType = patch.type === 'note' ? 'note' : 'memory'
          const wantedContent = String(patch.content ?? '')
          const adopted = wantedContent === '' ? undefined : current.items.find((candidate) => candidate.status === 'active'
            && candidate.type === wantedType
            && candidate.layer === patch.layer
            && candidate.content === wantedContent
            && (patch.key === undefined || patch.key === null || candidate.key === patch.key)
            && (run.sessionId === null || candidate.source?.sessionId === run.sessionId))
          if (adopted !== undefined) applied = adopted
        }
        if (applied === undefined) {
          applied = await createItem(patch, 'agent')
        }
        run.appliedItemId = applied.id
        if (run.targetId === null) run.targetId = applied.id
      } catch (error) {
        run.status = 'needs_user'
        run.error = truncate(String(error?.message ?? error), 1000)
        current.meta.audit = bucket
        await persist()
        throw createError('AUDIT_APPLY_FAILED', `候选写入失败：${error?.message ?? error}`)
      }
    }

    run.status = decision === 'approve' ? 'approved' : 'rejected'
    run.decision = {
      at,
      actor: truncate(String(actor), 40),
      note: truncate(String(note ?? ''), 500),
    }
    run.finishedAt = run.finishedAt ?? at
    // 只有真正应用过的 update 才归档原条目；create 的 targetId 可能指向已经写入的条目。
    if (decision === 'reject' && typeof run.targetId === 'string'
      && (run.action !== 'update' || typeof run.appliedItemId === 'string')) {
      const item = current.items.find((candidate) => candidate.id === run.targetId)
      if (item !== undefined && !layerInfo(item.layer).immutable) {
        const before = clone(item)
        item.status = 'archived'
        item.validTo = at
        item.updatedAt = at
        item.version = (item.version ?? 1) + 1
        reinforce(item, 'update')
        indexItem(item)
        recordChange('audit.reject', before, item, actor, '审计拒绝后归档')
        audit('audit.reject', `${item.layer}/${item.title} 经审计拒绝并归档`, actor)
      }
    }
    current.meta.audit = bucket
    await persist()
    return clone(run)
    } finally {
      auditDecisionsInFlight.delete(id)
    }
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
    writeHooks,
    diagnostics,
    injectionStats,
    // 自动记忆：只检测/排队，写入由 memory_capture 显式提交
    noteCaptureSignal,
    tickCapture,
    capturePrompt,
    capture,
    captureStats,
    usageStats,
    templates,
    saveTemplate,
    deleteTemplate,
    applyTemplate,
    consolidationCandidates,
    applyConsolidation,
    // 写入审计 Hook
    auditStats,
    auditRuns,
    recordAuditRun,
    finishAuditRun,
    decideAuditRun,
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
    // 人工关联：自动建边只认词面余弦，判错了、或者两条明明相关却没词面交集时，
    // 只能靠人工补一条。人工边存成 edge_type='manual'，重建自动边时不会被清掉。
    itemLinks: async (id, options = {}) => {
      if (typeof store.links !== 'function') return []
      return store.links(String(id ?? ''), options ?? {})
    },
    linkItems: async (params = {}, actor = 'user') => {
      const sourceId = String(params.sourceId ?? '')
      const targetId = String(params.targetId ?? '')
      if (sourceId === '' || targetId === '') throw relationError('需要 sourceId 与 targetId')
      if (sourceId === targetId) throw relationError('不能把条目连到自己')
      if (typeof store.linkItems !== 'function') throw relationError('当前存储不支持人工关联')
      const link = await store.linkItems({ sourceId, targetId, weight: params.weight })
      audit('link', `${sourceId} → ${targetId}`, actor)
      await persist()
      return link
    },
    unlinkItems: async (params = {}, actor = 'user') => {
      const sourceId = String(params.sourceId ?? '')
      const targetId = String(params.targetId ?? '')
      if (sourceId === '' || targetId === '') throw relationError('需要 sourceId 与 targetId')
      if (typeof store.unlinkItems !== 'function') throw relationError('当前存储不支持人工关联')
      const removed = await store.unlinkItems({ sourceId, targetId })
      if (removed > 0) {
        audit('unlink', `${sourceId} ↔ ${targetId}`, actor)
        await persist()
      }
      return { removed }
    },
    // 写入
    createItem,
    updateItem,
    resolveConflict,
    deleteItems,
    bulkAction,
    runMaintenance,
    // 提示词注入：当轮上下文（用户消息/工具报错）用于召回重排
    noteTurnContext,
    turnContext: () => ({
      sessionId: turnContext.sessionId,
      entries: turnContext.entries.length,
      at: turnContext.at,
      text: turnContextText(),
    }),
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
  const workspace = typeof options.workspace === 'string' && options.workspace.trim() !== '' && options.workspace !== '*'
    ? normalizeWorkspace(options.workspace)
    : undefined
  const now = Date.now()
  return items.filter((item) => {
    if (!layerEnabled(active, item.layer)) return false
    // 项目空间隔离：全局条目（workspace=null）对所有项目可见，项目条目只在本项目可见。
    if (workspace !== undefined && item.workspace !== null && item.workspace !== workspace) return false
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
    if ((status === 'usable' || status === 'active' || status === 'conflicted')
      && (item.duplicateOf !== null && item.duplicateOf !== undefined
        || item.supersededBy !== null && item.supersededBy !== undefined)) {
      return false
    }
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
function scoreItem(item, queryTokens, active, now, stats = undefined) {
  const relevance = queryRelevance(item, queryTokens, stats)
  const recency = recencyScore(item.updatedAt, active.retrieval.recencyHalfLifeDays, now)
  const importance = clampNumber(item.importance / 10, 0, 1, 0.5)
  const access = clampNumber(Math.log1p(item.accessCount ?? 0) / Math.log(11), 0, 1, 0)
  const pin = item.pinned ? active.retrieval.pinnedBoost : 0
  const weight = STATUS_WEIGHT[item.status] ?? 0.5
  const base = (relevance * 0.75 + importance * 0.12 + recency * 0.03 + access * 0.1) * weight
  return (base * forgettingFactor(item, active, now)) + pin * weight
}

/**
 * 词面相关度（0-1）：BM25 版的「查询词命中得分」。
 *
 * 早先是纯计数（标题×2 + 正文 + 标签×1.5，除以查询词数×2），所有词一视同仁，
 * 于是「一下」「这段」这种到处都有的词，和「灯塔」这种全库只有一条提过的词，
 * 分量一样重。改成 BM25：越少见的词权重越大（idf），长条目自动打折（长度归一），
 * 同一个词重复出现收益递减（tf 饱和）。最后除以「查询词全部打满」的上限，
 * 保持 0-1 的输出，好让 0.12 这个绝对阈值仍然有意义。
 */
function queryRelevance(item, queryTokens, stats = undefined) {
  if (queryTokens === undefined || queryTokens.size === 0) return 0
  const titleTokens = tokenize(item.title)
  const contentTokens = tokenize(item.content)
  const tagTokens = tokenize(item.tags.join(' '))
  const questionTokens = tokenize((item.questions ?? []).join(' '))
  // 标题与「能回答什么问题」同属「这条在讲什么」的高权重面：同一个词不重复计分，
  // 但两边任一对上就够了 —— 这样归一化分母不变，0.12 这个绝对阈值仍然有意义。
  const strongTokens = new Set([...titleTokens, ...questionTokens])
  if (stats === undefined) {
    let titleHits = 0
    let contentHits = 0
    let tagHits = 0
    for (const token of queryTokens) {
      if (strongTokens.has(token)) titleHits += 1
      if (contentTokens.has(token)) contentHits += 1
      if (tagTokens.has(token)) tagHits += 1
    }
    return clampNumber((titleHits * 2 + contentHits + tagHits * 1.5) / (queryTokens.size * 2), 0, 1, 0)
  }
  const k1 = 1.2
  const b = 0.75
  const docLen = stats.lengths.get(item.id) ?? contentTokens.size
  const avgLen = stats.avgLen > 0 ? stats.avgLen : 1
  const norm = k1 * (1 - b + (b * docLen) / avgLen)
  let raw = 0
  let ceiling = 0
  for (const token of queryTokens) {
    const df = stats.df.get(token) ?? 0
    if (df === 0) continue
    const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5))
    const tf = (strongTokens.has(token) ? 2 : 0) + (contentTokens.has(token) ? 1 : 0) + (tagTokens.has(token) ? 1.5 : 0)
    if (tf > 0) raw += idf * ((tf * (k1 + 1)) / (tf + norm))
    ceiling += idf * (k1 + 1)
  }
  if (ceiling === 0) return 0
  return clampNumber(raw / ceiling, 0, 1, 0)
}

/**
 * 候选集的词频背景：条目数、平均长度、每个词出现在几条里。
 * 只在一轮里算一次，供 BM25 打分复用。
 */
function corpusStats(candidates) {
  const df = new Map()
  const lengths = new Map()
  let total = 0
  for (const item of candidates) {
    const tokens = tokenize(searchableText(item))
    lengths.set(item.id, tokens.size)
    total += tokens.size
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return {
    n: candidates.length,
    avgLen: candidates.length > 0 ? total / candidates.length : 0,
    df,
    lengths,
  }
}

/**
 * 查询词在条目里对上了几个（标题 + 正文 + 标签）。
 * 「·命中」需要的不只是相对分高，还要有足够的字面证据。
 */
function matchedQueryTokens(item, queryTokens) {
  if (queryTokens === undefined || queryTokens.size === 0) return 0
  const haystack = tokenize(searchableText(item))
  let matched = 0
  for (const token of queryTokens) if (haystack.has(token)) matched += 1
  return matched
}

/**
 * 关系图谱（内存版）：按共享罕见词的余弦相似度连边。
 *
 * 只在候选集内建边、不落库：注入是同步链路，读库再爬图会把每次请求拖慢，
 * 而候选集本身很小（几十到几百条）。每条只留最近几条边，权重不到
 * GRAPH_EDGE_MIN 的不算——中文按二元组切词，不清洗的话整张图会连成一团。
 */
function graphEdgeIndex(candidates, stats) {
  const adjacency = new Map()
  if (stats === undefined || candidates.length < 2) return adjacency
  const n = candidates.length
  const ceiling = Math.max(2, Math.floor(n * QUERY_DF_RATIO))
  const vectors = new Map()
  for (const item of candidates) {
    const weights = new Map()
    for (const token of tokenize(searchableText(item))) {
      const df = stats.df.get(token) ?? 0
      if (df < 2 || df > ceiling) continue
      weights.set(token, Math.log((n + 1) / (df + 1)) + 1)
    }
    if (weights.size === 0) continue
    let square = 0
    for (const value of weights.values()) square += value * value
    vectors.set(item.id, { weights, norm: Math.sqrt(square) })
  }
  if (vectors.size < 2) return adjacency
  const postings = new Map()
  for (const [id, { weights }] of vectors) {
    for (const token of weights.keys()) {
      const bucket = postings.get(token)
      if (bucket === undefined) postings.set(token, [id])
      else bucket.push(id)
    }
  }
  const dots = new Map()
  for (const [token, bucket] of postings) {
    if (bucket.length < 2 || bucket.length > GRAPH_POSTING_MAX) continue
    for (let i = 0; i < bucket.length; i += 1) {
      const leftId = bucket[i]
      const leftWeight = vectors.get(leftId).weights.get(token)
      for (let j = i + 1; j < bucket.length; j += 1) {
        const rightId = bucket[j]
        const key = leftId < rightId ? `${leftId}|${rightId}` : `${rightId}|${leftId}`
        dots.set(key, (dots.get(key) ?? 0) + leftWeight * vectors.get(rightId).weights.get(token))
      }
    }
  }
  for (const [key, dot] of dots) {
    const [leftId, rightId] = key.split('|')
    const left = vectors.get(leftId)
    const right = vectors.get(rightId)
    if (left === undefined || right === undefined) continue
    const weight = dot / (left.norm * right.norm)
    if (!(weight >= GRAPH_EDGE_MIN)) continue
    pushEdge(adjacency, leftId, rightId, weight)
    pushEdge(adjacency, rightId, leftId, weight)
  }
  for (const list of adjacency.values()) {
    list.sort((left, right) => right[1] - left[1])
    if (list.length > GRAPH_NEIGHBORS) list.length = GRAPH_NEIGHBORS
  }
  return adjacency
}

function pushEdge(adjacency, from, to, weight) {
  const list = adjacency.get(from)
  if (list === undefined) adjacency.set(from, [[to, weight]])
  else list.push([to, weight])
}

/**
 * 把排在最前面的几条当作种子，沿边给邻居加分。
 *
 * 加的是「种子分 × 边权 × GRAPH_BONUS」，不是固定值：种子自己越确定，
 * 它拉进来的邻居越可信；边权越强，越可能是同一件事的两种说法。
 */
function applyGraphBonus(scored, edges) {
  if (edges.size === 0) return 0
  const seeds = [...scored].sort((left, right) => right.score - left.score).slice(0, GRAPH_SEEDS)
  const bonus = new Map()
  for (const seed of seeds) {
    if (!(seed.score > 0)) continue
    for (const [id, weight] of edges.get(seed.item.id) ?? []) {
      const value = seed.score * weight * GRAPH_BONUS
      if (value > (bonus.get(id) ?? 0)) bonus.set(id, value)
    }
  }
  let touched = 0
  for (const entry of scored) {
    const value = bonus.get(entry.item.id)
    if (value === undefined) continue
    entry.graph = Math.round(value * 1000) / 1000
    entry.score += value
    touched += 1
  }
  return touched
}

/**
 * 命中门槛：只标「明显最相关」的那条，分不出高低就一条都不标。
 *
 * 一句与记忆无关的话也能靠一两个通用词（「一下」「这段」）拿到 0.2-0.5 的相对分，
 * 光设绝对阈值会把一堆背景条目都标成命中。所以要同时满足三条：最高分至少到
 * RELEVANCE_HIT、最高分只有一条（并列就说明分不出高低）、并且明显高于第二档
 * （1.5 倍以上）；否则返回 Infinity，这一轮不标命中。
 */
function relevanceBar(relevances) {
  if (!Array.isArray(relevances) || relevances.length === 0) return Infinity
  const sorted = [...relevances].sort((left, right) => right - left)
  const top = sorted[0]
  if (!(top >= RELEVANCE_HIT)) return Infinity
  const tied = sorted.filter((value) => value >= top - 1e-6).length
  if (tied > 1) return Infinity
  const runnerUp = sorted.find((value) => value < top - 1e-6) ?? 0
  if (runnerUp > 0 && top < runnerUp * 1.5) return Infinity
  return top - 1e-9
}

/**
 * 从当轮上下文里挑判别力强的查询词。
 *
 * 直接拿整段话去打分会被两类词撑死：库里根本没人提的（df=0，永远不命中）
 * 和几乎每条记忆都有的（中文单字、"用户""记忆"这类，谁都能蹭分）。
 * 只留「至少一条、但不到一半」的词，再按稀有度取前 32 个：真正在聊的东西浮上来。
 */
function selectQueryTokens(text, candidates) {
  const raw = expandQueryTokens(tokenize(text))
  if (raw.size === 0 || candidates.length === 0) return new Set()
  // 超大库不在这里做全量 df：宁可退回重要度排序，也不把每次请求拖成几十毫秒。
  if (candidates.length > 4000) return new Set()
  const ceiling = Math.max(2, Math.floor(candidates.length * QUERY_DF_RATIO))
  const df = new Map()
  for (const item of candidates) {
    for (const token of tokenize(searchableText(item))) {
      if (raw.has(token)) df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const kept = []
  for (const [token, count] of df) {
    if (count === 0 || count > ceiling) continue
    if (QUERY_STOP_TOKENS.has(token)) continue
    kept.push({ token, count })
  }
  if (kept.length === 0) return new Set()
  kept.sort((left, right) => left.count - right.count)
  return new Set(kept.slice(0, QUERY_TOKEN_LIMIT).map((entry) => entry.token))
}

/**
 * 伪相关反馈的词：取最像的那条里「全库少见的词」，最多三条。
 * 目的是把「同义、换说法」的缺口拉回一点——他问「灯塔故事」，
 * 条目里写的是「那枚钥匙」，那就把「钥匙」也当查询词用一次。
 */
function feedbackTokens(item, queryTokens, stats) {
  const ceiling = Math.max(2, Math.floor(stats.n * 0.1))
  const candidates = []
  for (const token of tokenize(searchableText(item))) {
    if (queryTokens.has(token)) continue
    if (QUERY_STOP_TOKENS.has(token)) continue
    // 单字太泛（「碗」「灯」之外多半是虚词或噪声），只拿两字以上的词。
    if (token.length < 2) continue
    const df = stats.df.get(token) ?? 0
    if (df === 0 || df > ceiling) continue
    candidates.push({ token, df })
  }
  candidates.sort((left, right) => left.df - right.df)
  return new Set(candidates.slice(0, PRF_TOKEN_LIMIT).map((entry) => entry.token))
}

function recencyScore(iso, halfLifeDays, now) {
  const stamp = Date.parse(iso ?? '')
  if (!Number.isFinite(stamp)) return 0
  const days = Math.max(0, (now - stamp) / 86400000)
  const halfLife = Math.max(1, halfLifeDays)
  return Math.pow(0.5, days / halfLife)
}

/**
 * 遗忘曲线：离最后一次访问越久，检索权重越低；地板保证旧记忆不会彻底消失。
 * 只作用于排序，不改写用户填写的 importance，避免静默篡改数据。
 */
function forgettingFactor(item, active, now) {
  const config = active?.retrieval?.forgetting
  if (config === null || typeof config !== 'object' || config.enabled === false) return 1
  const stamp = Date.parse(item?.lastAccessAt ?? item?.updatedAt ?? item?.createdAt ?? '')
  if (!Number.isFinite(stamp)) return 1
  const days = Math.max(0, (now - stamp) / 86400000)
  const halfLife = Math.max(1, Number(config.halfLifeDays) || 90)
  const floor = clampNumber(config.floor, 0, 1, 0.25)
  return floor + (1 - floor) * Math.pow(0.5, days / halfLife)
}

/** 慢查询只留最近 N 条；阈值与上限都走设置，0 表示关闭。 */
function noteSlowQuery(current, active, entry) {
  const keep = clampInt(active?.maintenance?.slowQueryKeep, 0, 500, 50)
  if (keep === 0) return
  const threshold = clampInt(active?.maintenance?.slowQueryMs, 0, 60000, 200)
  if (!Number.isFinite(entry.tookMs) || entry.tookMs < threshold) return
  const list = Array.isArray(current.meta.slowQueries) ? current.meta.slowQueries : []
  list.push({
    at: entry.at,
    query: truncate(String(entry.query ?? ''), 120),
    tookMs: Math.round(entry.tookMs),
    results: clampInt(entry.results, 0, Number.MAX_SAFE_INTEGER, 0),
    path: truncate(String(entry.path ?? ''), 20),
  })
  current.meta.slowQueries = list.slice(-keep)
}

/** 记录一次实际注入的条目集合；同一组不重置已命中记录。 */
function noteInjection(current, ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))]
  const previous = current.meta.injection
  const previousIds = Array.isArray(previous?.ids) ? previous.ids : []
  const same = previousIds.length === unique.length && unique.every((id, index) => previousIds[index] === id)
  if (same) {
    previous.at = new Date().toISOString()
    return
  }
  current.meta.injection = {
    at: new Date().toISOString(),
    ids: unique,
    used: [],
    hitRate: 0,
  }
}

/** 检索命中注入过的条目时，累计“被用到”的条目数。 */
function noteInjectionHits(current, items) {
  const snapshot = current.meta.injection
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.ids)) return
  const injected = new Set(snapshot.ids)
  const used = new Set(Array.isArray(snapshot.used) ? snapshot.used : [])
  for (const item of items) {
    if (injected.has(item.id)) used.add(item.id)
  }
  snapshot.used = [...used]
  snapshot.hitRate = injected.size === 0 ? 0 : round(used.size / injected.size)
}

/** 健康分：冲突、过期、缺保鲜期、长期未访问与重复项各扣分。 */
function diagnosticsSnapshot(current, active) {
  const now = Date.now()
  const items = current.items
  const activeItems = items.filter((item) => item.status === 'active' || item.status === 'conflicted')
  const conflicted = items.filter((item) => item.status === 'conflicted').length
  const expired = activeItems.filter((item) => isExpiredItem(item, now)).length
  const missingTtl = activeItems.filter((item) => item.type === 'memory'
    && layerInfo(item.layer).immutable !== true
    && (item.expiresAt === null || item.expiresAt === undefined)).length
  const duplicate = items.filter((item) => typeof item.duplicateOf === 'string').length
  const stale = activeItems.filter((item) => {
    if (item.pinned) return false
    const stamp = Date.parse(item.lastAccessAt ?? item.updatedAt ?? item.createdAt ?? '')
    return Number.isFinite(stamp) && (now - stamp) / 86400000 > Math.max(1, active.maintenance.archiveAfterDays)
  }).length
  const issues = []
  if (conflicted > 0) issues.push({ id: 'conflicts', count: conflicted, severity: 'high', label: { zh: '待解决冲突', en: 'Unresolved conflicts' } })
  if (expired > 0) issues.push({ id: 'expired', count: expired, severity: 'medium', label: { zh: '已过期但仍活跃', en: 'Expired but still active' } })
  if (missingTtl > 0) issues.push({ id: 'ttl', count: missingTtl, severity: 'high', label: { zh: '缺少保鲜期', en: 'Missing freshness period' } })
  if (stale > 0) issues.push({ id: 'stale', count: stale, severity: 'low', label: { zh: '长期未访问', en: 'Long unused' } })
  if (duplicate > 0) issues.push({ id: 'duplicates', count: duplicate, severity: 'low', label: { zh: '疑似重复', en: 'Possible duplicates' } })
  let score = 100 - conflicted * 8 - expired * 4 - missingTtl * 2 - stale * 1 - duplicate * 1
  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 85 ? 'healthy' : score >= 65 ? 'attention' : 'risk'
  const injection = current.meta.injection
  const injected = Array.isArray(injection?.ids) ? injection.ids.length : 0
  const used = Array.isArray(injection?.used) ? injection.used.length : 0
  return {
    at: new Date().toISOString(),
    health: {
      score,
      grade,
      issues,
      counts: { total: items.length, active: activeItems.length, conflicted, expired, missingTtl, stale, duplicate },
    },
    slowQueries: Array.isArray(current.meta.slowQueries) ? current.meta.slowQueries.slice(-50) : [],
    maintenanceRuns: Array.isArray(current.meta.maintenanceRuns) ? current.meta.maintenanceRuns.slice(-20) : [],
    capture: {
      pending: Array.isArray(current.meta.capture?.pending) ? current.meta.capture.pending.length : 0,
      runs: Array.isArray(current.meta.capture?.runs) ? current.meta.capture.runs.length : 0,
      lastSmallReviewAt: current.meta.capture?.lastSmallReviewAt ?? null,
      lastLargeReviewAt: current.meta.capture?.lastLargeReviewAt ?? null,
    },
    injection: {
      at: injection?.at ?? null,
      injected,
      used,
      hitRate: injected === 0 ? 0 : round(used / injected),
    },
  }
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
    } else if (field === 'questions') {
      out.questions = Array.isArray(raw.questions) ? raw.questions.filter((question) => typeof question === 'string').slice(0, MAX_QUESTIONS) : []
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

function normalizeAuditStore(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const runs = Array.isArray(source.runs)
    ? source.runs.map(normalizeAuditRun).filter((run) => run !== undefined).slice(-500)
    : []
  return { version: 1, runs }
}

function normalizeCaptureStore(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const pending = Array.isArray(source.pending)
    ? source.pending
      .filter((entry) => entry !== null && typeof entry === 'object' && CAPTURE_TRIGGERS.includes(entry.trigger))
      .map((entry) => ({
        id: typeof entry.id === 'string' && /^cap_[A-Za-z0-9_-]{4,40}$/.test(entry.id) ? entry.id : `cap_${randomUUID().slice(0, 8)}`,
        trigger: entry.trigger,
        reason: truncate(String(entry.reason ?? ''), 200),
        at: isoOr(entry.at, new Date().toISOString()),
        sessionId: typeof entry.sessionId === 'string' ? truncate(entry.sessionId, 120) : null,
        turn: Number.isFinite(Number(entry.turn)) ? Number(entry.turn) : null,
        text: truncate(String(entry.text ?? ''), 2000),
        since: isoOr(entry.since, null),
        until: isoOr(entry.until, null),
      }))
      .slice(-100)
    : []
  const runs = Array.isArray(source.runs)
    ? source.runs
      .filter((run) => run !== null && typeof run === 'object' && CAPTURE_TRIGGERS.includes(run.trigger))
      .map((run) => ({
        id: typeof run.id === 'string' ? truncate(run.id, 64) : `cap_${randomUUID().slice(0, 8)}`,
        trigger: run.trigger,
        at: isoOr(run.at, new Date().toISOString()),
        actor: truncate(String(run.actor ?? 'agent'), 40),
        sessionId: typeof run.sessionId === 'string' ? truncate(run.sessionId, 120) : null,
        turn: Number.isFinite(Number(run.turn)) ? Number(run.turn) : null,
        summary: truncate(String(run.summary ?? ''), 2000),
        created: Array.isArray(run.created) ? run.created.slice(0, 40) : [],
        updated: Array.isArray(run.updated) ? run.updated.slice(0, 40) : [],
        skipped: Array.isArray(run.skipped) ? run.skipped.slice(0, 40) : [],
        errors: Array.isArray(run.errors) ? run.errors.slice(0, 40) : [],
      }))
      .slice(-50)
    : []
  return {
    version: 1,
    pending,
    runs,
    lastSignalAt: isoOr(source.lastSignalAt, null),
    lastSmallReviewAt: isoOr(source.lastSmallReviewAt, null),
    lastLargeReviewAt: isoOr(source.lastLargeReviewAt, null),
    lastSmallQueuedAt: isoOr(source.lastSmallQueuedAt, null),
    lastLargeQueuedAt: isoOr(source.lastLargeQueuedAt, null),
  }
}

function normalizeAuditRun(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const status = AUDIT_RUN_STATUSES.includes(raw.status) ? raw.status : 'failed'
  const verdict = AUDIT_VERDICTS.includes(raw.verdict) ? raw.verdict : null
  const at = isoOr(raw.at, new Date().toISOString())
  const usage = normalizeUsage(raw.usage)
  return {
    id: typeof raw.id === 'string' && /^audit_[A-Za-z0-9_-]{4,80}$/.test(raw.id) ? raw.id : `audit_${randomUUID().slice(0, 12)}`,
    at,
    startedAt: isoOr(raw.startedAt, at),
    finishedAt: raw.finishedAt === null || raw.finishedAt === undefined ? null : isoOr(raw.finishedAt, null),
    durationMs: clampInt(raw.durationMs, 0, 86400000, 0),
    tool: ['memory_write', 'memory_update'].includes(raw.tool) ? raw.tool : 'memory_write',
    callId: typeof raw.callId === 'string' ? truncate(raw.callId, 120) : null,
    sessionId: typeof raw.sessionId === 'string' ? truncate(raw.sessionId, 120) : null,
    action: raw.action === 'update' ? 'update' : 'create',
    status,
    verdict,
    enforced: raw.enforced === true,
    confidence: clampNumber(raw.confidence, 0, 1, 0),
    reason: truncate(String(raw.reason ?? ''), 1000),
    targetId: typeof raw.targetId === 'string' ? truncate(raw.targetId, 64) : null,
    sourceQuote: typeof raw.sourceQuote === 'string' ? truncate(raw.sourceQuote, MAX_SOURCE_QUOTE) : null,
    proposed: sanitizeAuditPayload(raw.proposed),
    appliedItemId: typeof raw.appliedItemId === 'string' ? truncate(raw.appliedItemId, 64) : null,
    before: sanitizeAuditPayload(raw.before),
    after: sanitizeAuditPayload(raw.after),
    error: typeof raw.error === 'string' ? truncate(raw.error, 1000) : null,
    decision: raw.decision !== null && typeof raw.decision === 'object'
      ? {
        at: isoOr(raw.decision.at, at),
        actor: truncate(String(raw.decision.actor ?? 'user'), 40),
        note: truncate(String(raw.decision.note ?? ''), 500),
      }
      : null,
    usage,
  }
}

function sanitizeAuditPayload(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const out = {}
  if (raw.id !== undefined) out.id = truncate(String(raw.id), 64)
  if (raw.type !== undefined) out.type = raw.type === 'note' ? 'note' : 'memory'
  if (raw.layer !== undefined) out.layer = LAYER_IDS.includes(raw.layer) ? raw.layer : 'L4'
  if (raw.title !== undefined) out.title = truncate(String(raw.title), MAX_TITLE)
  if (raw.content !== undefined) out.content = truncate(String(raw.content), MAX_CONTENT)
  if (raw.key !== undefined) out.key = safeNormalizeKey(raw.key)
  if (raw.tags !== undefined) out.tags = normalizeTags(raw.tags)
  if (raw.importance !== undefined) out.importance = clampInt(raw.importance, 1, 10, 5)
  if (raw.notebook !== undefined) out.notebook = normalizeNotebook(raw.notebook)
  if (raw.ttlDays !== undefined) out.ttlDays = clampInt(raw.ttlDays, 1, 3650, null)
  if (raw.supersedes !== undefined) out.supersedes = normalizeIdList(raw.supersedes)
  return out
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
}

function normalizeUsage(raw) {
  const out = emptyUsage()
  if (raw === null || typeof raw !== 'object') return out
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    out[field] = clampInt(raw[field], 0, Number.MAX_SAFE_INTEGER, 0)
  }
  out.totalTokens = clampInt(
    raw.totalTokens,
    0,
    Number.MAX_SAFE_INTEGER,
    out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheWriteTokens,
  )
  return out
}

function addUsage(target, usage) {
  const normalized = normalizeUsage(usage)
  target.inputTokens += normalized.inputTokens
  target.outputTokens += normalized.outputTokens
  target.cacheReadTokens += normalized.cacheReadTokens
  target.cacheWriteTokens += normalized.cacheWriteTokens
  target.totalTokens += normalized.totalTokens
}

function normalizeKey(value) {
  if (value === null || value === undefined) return null
  const key = String(value).trim()
  if (key === '') return null
  if (key.length > MAX_KEY) throw createError('KEY_TOO_LONG', `实体键最多 ${MAX_KEY} 个字符`)
  if (!/^[^\s][\s\S]*$/.test(key)) throw createError('INVALID_KEY', '实体键不能为空或只包含空白')
  return key
}

function safeNormalizeKey(value) {
  try {
    return normalizeKey(value)
  } catch {
    return null
  }
}

function normalizeIdList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const out = []
  for (const candidate of list) {
    const id = truncate(String(candidate ?? '').trim(), 64)
    if (id === '' || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_SUPERSEDES) break
  }
  return out
}

function normalizeSource(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    kind: ['user', 'agent', 'system', 'import'].includes(source.kind) ? source.kind : 'user',
    sessionId: typeof source.sessionId === 'string' ? truncate(source.sessionId, 120) : null,
    workspace: typeof source.workspace === 'string' ? truncate(source.workspace, 400) : null,
    quote: typeof source.quote === 'string' && source.quote.trim() !== ''
      ? truncate(source.quote, MAX_SOURCE_QUOTE)
      : null,
    turn: Number.isInteger(source.turn) && source.turn >= 0 ? source.turn : null,
    confidence: source.confidence === null || source.confidence === undefined
      ? null
      : clampNumber(source.confidence, 0, 1, null),
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
    questions: normalizeQuestions(raw.questions),
    importance: clampInt(raw.importance, 1, 10, 5),
    status: ITEM_STATUSES.includes(raw.status) ? raw.status : 'active',
    pinned: raw.pinned === true,
    ttlDays: typeof raw.ttlDays === 'number' && Number.isFinite(raw.ttlDays) ? Math.max(1, Math.round(raw.ttlDays)) : null,
    expiresAt: typeof raw.expiresAt === 'string' && Number.isFinite(Date.parse(raw.expiresAt)) ? raw.expiresAt : null,
    key: safeNormalizeKey(raw.key),
    workspace: normalizeWorkspace(raw.workspace ?? raw.source?.workspace),
    source: normalizeSource(raw.source),
    supersedes: normalizeIdList(raw.supersedes),
    supersededBy: typeof raw.supersededBy === 'string' ? truncate(raw.supersededBy, 64) : null,
    validFrom: isoOr(raw.validFrom, createdAt),
    validTo: typeof raw.validTo === 'string' && Number.isFinite(Date.parse(raw.validTo)) ? raw.validTo : null,
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

/** 项目空间标识：只做路径规范化，不去读磁盘；空值表示全局记忆。 */
function normalizeWorkspace(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return text === '' ? null : truncate(text.toLowerCase(), 400)
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const text = entry.replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(truncate(text, MAX_QUESTION_LENGTH))
    if (out.length >= MAX_QUESTIONS) break
  }
  return out
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

function assertLayerWritable(active, layer, actor = 'agent') {
  const info = layerInfo(layer)
  if (!layerEnabled(active, layer)) throw createError('LAYER_DISABLED', `${layer} 已在设置里关闭`)
  // 不可变层只对智能体只读：啸春本人在界面上可以随时改、随时删。
  // 设置里的 allowImmutableEdit 仅作为"也放开给智能体"的开关，默认关闭。
  if (info.immutable && actor !== 'user' && !active.write.allowImmutableEdit) {
    throw createError('READ_ONLY', `${layer} ${info.name.zh} 对智能体只读（用户可在记忆面板里直接修改）`)
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
  'memory_link',
  'memory_diff',
  'memory_capture',
]

// 记事本列表在模块初始化后填充（NOTEBOOKS 来自 settings.js）。
import { NOTEBOOKS } from './settings.js'
NOTEBOOK_LIST.push(...NOTEBOOKS)

export { message, getPath }

/**
 * 人工关联操作失败时的错误：带上 code，接口层据此返回 400 而不是 500。
 */
function relationError(text) {
  const error = new Error(text)
  error.code = 'INVALID_ARGUMENT'
  return error
}








