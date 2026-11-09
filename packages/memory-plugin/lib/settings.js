/**
 * 记忆插件的设置模型。
 *
 * 三层结构：
 *   1. `DEFAULT_SETTINGS` —— 出厂默认值（唯一的真源）；
 *   2. `SETTINGS_SCHEMA`  —— 设置页的渲染描述（分组、类型、范围、中英标签），
 *      由 Host 随 `settings.get` 一起下发，客户端不需要重复维护一份表单定义；
 *   3. `normalizeSettings` —— 把任意来源（patch 行的 config、磁盘上的旧文件、
 *      设置页提交的 patch）收敛成一份合法设置：类型不对、超范围、未知枚举一律回退默认值。
 *
 * 设计原则：任何"设置"都必须真的有代码读它。没有实现的开关不放进来。
 */

/** 记忆层定义（供引擎与 UI 共用）。 */
export const LAYERS = [
  {
    id: 'L0',
    name: { zh: '灵魂层', en: 'Soul' },
    desc: { zh: '身份与不可变的底层设定', en: 'Identity and immutable ground truth' },
    immutable: true,
    order: 0,
  },
  {
    id: 'L1',
    name: { zh: '思想核心', en: 'Core thoughts' },
    desc: { zh: '稳定的价值观与判断准则', en: 'Stable values and judgement rules' },
    immutable: true,
    order: 1,
  },
  {
    id: 'L2',
    name: { zh: '思想流动', en: 'Thought flow' },
    desc: { zh: '允许变化，需要冲突检测', en: 'Mutable, conflict-checked' },
    immutable: false,
    conflictable: true,
    order: 2,
  },
  {
    id: 'L3',
    name: { zh: '本能行为', en: 'Instincts' },
    desc: { zh: '固定的行为反射', en: 'Fixed behavioural reflexes' },
    immutable: true,
    order: 3,
  },
  {
    id: 'L4',
    name: { zh: '学习行为', en: 'Learned behaviour' },
    desc: { zh: '从经验中学到的做法', en: 'Practices learned from experience' },
    immutable: false,
    order: 4,
  },
  {
    id: 'L5',
    name: { zh: '目标记忆', en: 'Goals' },
    desc: { zh: '长期目标与进行中的计划', en: 'Long-running goals and plans' },
    immutable: false,
    order: 5,
  },
  {
    id: 'L6',
    name: { zh: '轮转记忆', en: 'Rotation' },
    desc: { zh: '按保鲜期自动清理的临时记忆', en: 'Short-lived memories with a TTL' },
    immutable: false,
    ttl: true,
    order: 6,
  },
  {
    id: 'L7',
    name: { zh: '情境感知', en: 'Context' },
    desc: { zh: '会话级别的临时上下文', en: 'Session-scoped context' },
    immutable: false,
    ttl: true,
    order: 7,
  },
]

export const LAYER_IDS = LAYERS.map((layer) => layer.id)

/** 记事本定义。 */
export const NOTEBOOKS = [
  { id: 'memory', name: { zh: '零碎记忆记事本', en: 'Fragment notes' }, desc: { zh: '一句话就能说完的零碎事实（谁、在哪、叫什么、多少），不需要背景说明', en: 'One-line fragments: who, where, what it is called, how much' } },
  { id: 'daily', name: { zh: '日常记事本', en: 'Daily notes' }, desc: { zh: '按日期记录的工作日志', en: 'Dated work log' } },
  { id: 'asset', name: { zh: '资产记事本', en: 'Asset notes' }, desc: { zh: '路径、账号、配置等可复用资产', en: 'Paths, accounts and reusable assets' } },
  { id: 'pitfall', name: { zh: '踩坑笔记', en: 'Pitfall notes' }, desc: { zh: '历史踩坑事件、根因与可复用的解决办法', en: 'Past pitfalls, root causes and reusable fixes' } },
]

export const NOTEBOOK_IDS = NOTEBOOKS.map((notebook) => notebook.id)

/**
 * 记忆模板：一套可直接热切换的「不可变层 + 注入策略」。
 *
 * L0 灵魂层 / L1 思想核心 / L3 本能行为属于模板，随模板切换；
 * L2 思想流动与 L4-L7 可改写层存在共享数据库里，不随模板复制或删除。
 */
export const TEMPLATE_LAYER_IDS = ['L0', 'L1', 'L3']
export const TEMPLATE_LAYER_META = TEMPLATE_LAYER_IDS.map((id) => LAYERS.find((layer) => layer.id === id))
const TEMPLATE_LAYER_MAX_ENTRIES = 20
const TEMPLATE_LAYER_TITLE_MAX = 80
const TEMPLATE_LAYER_CONTENT_MAX = 2000
const TEMPLATE_LAYER_CHARS_MAX = 12000

/** 不可变层条目：每条都必须能独立看出“属于哪一层、说什么”。 */
export function sanitizeTemplateLayers(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const layers = { L0: [], L1: [], L3: [] }
  let totalChars = 0
  for (const id of TEMPLATE_LAYER_IDS) {
    const entries = Array.isArray(source[id]) ? source[id] : []
    for (const entry of entries) {
      if (layers[id].length >= TEMPLATE_LAYER_MAX_ENTRIES) break
      const record = typeof entry === 'string' ? { content: entry } : (entry ?? {})
      let title = String(record.title ?? '').trim().slice(0, TEMPLATE_LAYER_TITLE_MAX)
      const content = String(record.content ?? '').trim().slice(0, TEMPLATE_LAYER_CONTENT_MAX)
      if (content === '') continue
      if (title === '') title = content.split('\n')[0].slice(0, 24)
      const remaining = TEMPLATE_LAYER_CHARS_MAX - totalChars
      if (remaining <= 0) break
      const clipped = content.slice(0, remaining)
      if (clipped === '') break
      layers[id].push({ title, content: clipped })
      totalChars += clipped.length
    }
  }
  return layers
}

/** 模板不可变层是否真的有内容。 */
export function hasTemplateLayers(template) {
  return TEMPLATE_LAYER_IDS.some((id) => (template?.layers?.[id]?.length ?? 0) > 0)
}

/** 内置模板的空层结构，保证 API/UI 拿到的形状一致。 */
function emptyTemplateLayers() {
  return { L0: [], L1: [], L3: [] }
}

export const MEMORY_TEMPLATES = [
  {
    id: 'default',
    name: { zh: '通用模板', en: 'General' },
    desc: { zh: '平衡型：重要度、置顶与新鲜度综合排序，适合日常使用。', en: 'Balanced ranking for everyday use.' },
    header: [
      '## 长期记忆（dsh-memory-plugin）',
      '下面是从跨会话记忆里挑出的、可能相关的条目。只在确实相关时使用，不要臆造未列出的记忆。',
      '需要更多细节时用 memory_search 检索；新的关键事实用 memory_write 保存。',
    ].join('\n'),
    topN: 6,
    maxChars: 1200,
    layers: emptyTemplateLayers(),
  },
  {
    id: 'dev',
    name: { zh: '开发模板', en: 'Development' },
    desc: { zh: '开发导向：优先项目事实、构建命令、架构决策与踩坑记录，注入条数更多。', en: 'Project facts, build commands, architecture decisions and lessons; larger budget.' },
    header: [
      '## 项目长期记忆（dsh-memory-plugin · 开发模板）',
      '下面是与当前开发工作相关的历史事实、命令、架构决策与踩坑记录。优先复用这些结论，避免重复试错；与当前代码冲突时以实际代码为准。',
      '需要更多细节时用 memory_search 检索（可用 type=note 查开发记事本）；新的关键事实用 memory_write 保存，并填写保鲜期。',
    ].join('\n'),
    topN: 10,
    maxChars: 1800,
    layers: emptyTemplateLayers(),
  },
  {
    id: 'qqbot',
    name: { zh: 'QQ 机器人模板', en: 'QQ bot' },
    desc: { zh: '对话导向：优先用户偏好、群聊背景与稳定人设，预算更紧，避免跨群泄露。', en: 'User preferences, group context and stable persona; tighter budget.' },
    header: [
      '## 跨会话记忆（dsh-memory-plugin · QQ 机器人）',
      '下面是可能相关的用户偏好、群聊背景与稳定约定。只在当前对话确实需要时使用；不要把 A 群/私聊的内容带到 B 群，也不要编造未列出的记忆。',
      '需要更多细节时用 memory_search 检索；新的稳定偏好用 memory_write 保存，并填写保鲜期。',
    ].join('\n'),
    topN: 8,
    maxChars: 900,
    layers: emptyTemplateLayers(),
  },
]

export const TEMPLATE_IDS = MEMORY_TEMPLATES.map((template) => template.id)
const MAX_CUSTOM_TEMPLATES = 50

/**
 * 校验并收敛一条用户自定义模板。
 *
 * 模板承载不可变层（L0/L1/L3）与注入预算；它不复制、不改写共享的
 * L2/L4-L7 数据。每条层内条目都保留标题，避免 UI 只剩一个大输入框。
 */
export function sanitizeCustomTemplate(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const name = String(raw.name ?? '').trim().slice(0, 40)
  const header = String(raw.header ?? '').trim().slice(0, 4000)
  const desc = String(raw.desc ?? '').trim().slice(0, 120)
  const topN = Math.round(Number(raw.topN))
  const maxChars = Math.round(Number(raw.maxChars))
  if (name === '' || header === '') return undefined
  if (!Number.isFinite(topN) || topN < 1 || topN > 60) return undefined
  if (!Number.isFinite(maxChars) || maxChars < 100 || maxChars > 8000) return undefined
  const id = typeof raw.id === 'string' && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(raw.id)
    ? raw.id
    : undefined
  if (id !== undefined && TEMPLATE_IDS.includes(id)) return undefined
  return {
    id,
    name,
    desc,
    header,
    topN,
    maxChars,
    layers: sanitizeTemplateLayers(raw.layers),
    custom: true,
  }
}

/** 从设置里收敛自定义模板数组：丢弃非法项、内置 id 与重复 id。 */
export function normalizeCustomTemplates(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    const template = sanitizeCustomTemplate(raw)
    if (template === undefined || template.id === undefined) continue
    if (seen.has(template.id)) continue
    seen.add(template.id)
    out.push(template)
    if (out.length >= MAX_CUSTOM_TEMPLATES) break
  }
  return out
}

/** 内置 + 自定义模板。 */
export function allTemplates(settings) {
  return [...MEMORY_TEMPLATES, ...(settings?.prompt?.customTemplates ?? [])]
}

/** 按 id 取模板；未知 id 回退通用模板。 */
export function templateById(id, settings = null) {
  const list = allTemplates(settings)
  return list.find((template) => template.id === id) ?? MEMORY_TEMPLATES[0]
}

/** 当前生效的模板。 */
export function activeTemplate(settings) {
  return templateById(settings?.prompt?.template, settings)
}

/**
 * 固化目标层：L1 思想核心 / L3 本能行为，均为不可变、永久。
 * `auto` 按来源层判断：思想流动 L2 → L1，其余学习/目标/临时层 → L3。
 */
export function consolidationTargetFor(itemLayer, settings) {
  const configured = settings?.consolidation?.targetLayer
  if (configured === 'L1' || configured === 'L3') return configured
  return itemLayer === 'L2' ? 'L1' : 'L3'
}

/** 注入预算：默认跟随模板，打开 overrideBudget 后才读 prompt.topN / maxChars。 */
export function promptBudget(settings) {
  const template = activeTemplate(settings)
  const prompt = settings?.prompt ?? {}
  if (prompt.overrideBudget === true) {
    return {
      topN: Math.max(0, Number(prompt.topN) || 0),
      maxChars: Math.max(0, Number(prompt.maxChars) || 0),
    }
  }
  return { topN: template.topN, maxChars: template.maxChars }
}


/** 出厂默认设置。 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  ui: {
    language: 'auto',
    pageSize: 20,
    confirmDelete: true,
    showLayerBadges: true,
  },
  storage: {
    engine: 'auto',
    dir: '',
    backupKeep: 3,
    autoBackup: true,
    autoBackupHours: 24,
  },
  retrieval: {
    defaultLimit: 8,
    maxLimit: 50,
    minScore: 0.15,
    recencyHalfLifeDays: 30,
    // 遗忘曲线：按 lastAccessAt 衰减排序权重，地板保证旧记忆仍可能被命中。
    forgetting: { enabled: true, halfLifeDays: 90, floor: 0.25 },
    pinnedBoost: 0.25,
    // 混合检索开关与权重（设计文档 §5.5：全文 / 语义 / 图谱）
    semantic: true,
    graph: true,
    weights: { fulltext: 0.4, semantic: 0.4, graph: 0.2 },
    cacheSize: 256,
    graphDepth: 2,
    graphSeeds: 5,
    graphMinWeight: 0.22,
  },
  write: {
    minContentLength: 8,
    dedupeThreshold: 0.9,
    defaultImportance: 5,
    allowImmutableEdit: false,
    // 可修改层必须填写保鲜期，这是硬约束，不提供关闭开关。
    defaultTtlDays: 30,
  },
  layers: {
    L0: true,
    L1: true,
    L2: true,
    L3: true,
    L4: true,
    L5: true,
    L6: true,
    L7: true,
  },
  prompt: {
    inject: true,
    template: 'default',
    topN: 6,
    maxChars: 1200,
    // 用户自定义模板；内置模板见 MEMORY_TEMPLATES。
    customTemplates: [],
    // 默认跟随模板预算；打开后才用上面的 topN / maxChars 覆盖。
    overrideBudget: false,
  },
  consolidation: {
    enabled: true,
    threshold: 4,
    windowDays: 14,
    // auto：L2 → L1 思想核心，其余 → L3 本能行为；也可显式锁定 L1 / L3。
    targetLayer: 'auto',
    minImportance: 6,
    maxCandidates: 20,
    // 必须由智能体调用 memory_consolidate 明确批准，维护任务只产生候选。
    autoApply: false,
  },
  hook: {
    enabled: false,
    enforce: true,
    minConfidence: 0.7,
    timeoutSeconds: 45,
    maxRuns: 100,
  },
  autoCapture: {
    // 只产生“提醒”，真正写什么由智能体调用 memory_capture 决定。
    enabled: true,
    immediate: true,
    smallEnabled: true,
    smallIntervalHours: 4,
    smallWindowHours: 4,
    largeEnabled: true,
    largeAt: '04:00',
    largeLookbackDays: 7,
    maxFacts: 6,
    maxNotes: 6,
    noteDedupe: 0.92,
    queueKeep: 20,
    // 自适应限流：连续回顾都写不出东西时自动拉长回顾间隔（最多 3 倍），
    // 一旦写出来就往回收。只影响小/大回顾，不影响即时信号。
    adaptiveThrottle: true,
  },
  maintenance: {
    autoRun: true,
    intervalHours: 6,
    ttlDays: 30,
    archiveAfterDays: 180,
    promoteAccessCount: 3,
    conflictThreshold: 0.82,
    auditKeep: 200,
    // 变更历史独立于普通审计保留：diff 按时间段查询时不能只剩最近 200 条操作摘要。
    diffKeep: 3000,
    autoPromote: false,
    rotateMinImportance: 0.3,
    maxItems: 100000,
    // 可观测性：最近维护历史、慢查询阈值与日志上限。
    historyKeep: 20,
    slowQueryMs: 200,
    slowQueryKeep: 50,
    // 保留策略：按层 / 按记事本分别给天数，0 表示不设（这些条目交给 cleanup / archive 的
    // 全局规则处理）。只归档，不删除：archived 条目仍能在面板里筛出来、能导出。
    retention: {
      byLayer: { L2: 0, L4: 0, L5: 0, L6: 0, L7: 0 },
      byNotebook: { memory: 0, daily: 0, asset: 0, pitfall: 0 },
    },
  },
  performance: {
    nativeCore: true,
  },
  privacy: {
    auditLog: true,
  },
  tools: {
    enabled: true,
  },
}

/** 下拉框选项。 */
const LANGUAGE_OPTIONS = [
  { value: 'auto', label: { zh: '跟随界面语言', en: 'Follow the interface' } },
  { value: 'zh', label: { zh: '中文', en: 'Chinese' } },
  { value: 'en', label: { zh: 'English', en: 'English' } },
]

const SORT_OPTIONS = [
  { value: 'updated', label: { zh: '最近更新', en: 'Recently updated' } },
  { value: 'created', label: { zh: '最近创建', en: 'Recently created' } },
  { value: 'importance', label: { zh: '重要度', en: 'Importance' } },
  { value: 'title', label: { zh: '标题', en: 'Title' } },
]

/**
 * 设置页的表单描述。客户端按分组渲染，不写死任何字段。
 * `path` 是 `DEFAULT_SETTINGS` 里的点分路径。
 */
export const SETTINGS_SCHEMA = [
  {
    id: 'general',
    title: { zh: '通用', en: 'General' },
    desc: { zh: '插件总开关与界面偏好', en: 'Master switch and interface preferences' },
    fields: [
      {
        path: 'enabled',
        type: 'boolean',
        label: { zh: '启用记忆插件', en: 'Enable the memory plugin' },
        hint: { zh: '关闭后不再写入、检索，也不再向模型注入记忆；数据保留。', en: 'When off, no writes, retrieval or prompt injection happen. Data is kept.' },
      },
      {
        path: 'ui.language',
        type: 'select',
        label: { zh: '界面语言', en: 'Interface language' },
        hint: { zh: '设置页与提示文字使用的语言。', en: 'Language used by the settings page and messages.' },
        options: LANGUAGE_OPTIONS,
      },
      {
        path: 'ui.pageSize',
        type: 'number',
        min: 5,
        max: 100,
        step: 5,
        unit: { zh: '条', en: 'rows' },
        label: { zh: '每页条数', en: 'Rows per page' },
        hint: { zh: '记忆与记事本列表每页显示多少条。', en: 'How many rows each list page shows.' },
      },
      {
        path: 'ui.confirmDelete',
        type: 'boolean',
        label: { zh: '删除前确认', en: 'Confirm before deleting' },
        hint: { zh: '删除记忆或记事本时弹出二次确认。', en: 'Ask for confirmation before deleting.' },
      },
      {
        path: 'ui.showLayerBadges',
        type: 'boolean',
        label: { zh: '显示分层标签', en: 'Show layer badges' },
        hint: { zh: '在列表里显示 L0–L7 的分层角标。', en: 'Show the L0–L7 badge in lists.' },
      },
    ],
  },
  {
    id: 'storage',
    title: { zh: '存储', en: 'Storage' },
    desc: { zh: '数据文件位置与备份', en: 'Data file location and backups' },
    fields: [
      {
        path: 'storage.engine',
        type: 'select',
        options: [
          { value: 'auto', label: { zh: '自动（Go 服务优先）', en: 'Automatic (Go service first)' } },
          { value: 'go', label: { zh: 'Go 服务（SQLite + FTS5 + 图谱）', en: 'Go service (SQLite + FTS5 + graph)' } },
          { value: 'sqlite', label: { zh: 'Node 内置 SQLite（回退）', en: 'Node built-in SQLite (fallback)' } },
          { value: 'json', label: { zh: 'JSON 单文件（兼容/排障）', en: 'Single JSON file (compatibility/debug)' } },
        ],
        label: { zh: '存储引擎', en: 'Storage engine' },
        hint: { zh: '自动 = 优先使用 Go 服务（持久化 + 检索都在 Go 里）；二进制缺失时回退到 Node 内置 SQLite。切换后需要重载插件。', en: 'Automatic prefers the Go service (persistence and retrieval live there); missing binary falls back to Node SQLite. Reload after switching.' },
      },
      {
        path: 'storage.dir',
        type: 'text',
        placeholder: { zh: '留空表示 <DSH_HOME>/storages/dsh-memory-plugin', en: 'Empty means <DSH_HOME>/storages/dsh-memory-plugin' },
        label: { zh: '数据目录', en: 'Data directory' },
        hint: { zh: '留空使用默认目录；修改后需要重载插件才生效。', en: 'Leave empty for the default; reload the plugin to apply a change.' },
      },
      {
        path: 'storage.backupKeep',
        type: 'number',
        min: 0,
        max: 20,
        step: 1,
        unit: { zh: '份', en: 'files' },
        label: { zh: '保留备份份数', en: 'Backups to keep' },
        hint: { zh: '每次打开记忆库前轮转一份 backup（memory.sqlite3.bak-N 或 store.json.bak-N）；0 表示不备份。', en: 'Rotate one backup before the store opens (memory.sqlite3.bak-N or store.json.bak-N); 0 disables.' },
      },
      {
        path: 'storage.autoBackup',
        type: 'boolean',
        label: { zh: '定时自动备份', en: 'Automatic backups' },
        hint: { zh: '按下面的间隔把数据库复制到 backups/ 目录，默认保留最近 10 份。', en: 'Copies the database into backups/ on an interval; the last 10 are kept.' },
      },
      {
        path: 'storage.autoBackupHours',
        type: 'number',
        min: 1,
        max: 168,
        step: 1,
        unit: { zh: '小时', en: 'hours' },
        label: { zh: '自动备份间隔', en: 'Backup interval' },
        hint: { zh: '两次自动备份之间的最短间隔。', en: 'Minimum gap between automatic backups.' },
      },
    ],
  },
  {
    id: 'retrieval',
    title: { zh: '检索', en: 'Retrieval' },
    desc: { zh: '关键词加权检索的打分参数', en: 'Scoring for weighted keyword retrieval' },
    fields: [
      {
        path: 'retrieval.defaultLimit',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        unit: { zh: '条', en: 'results' },
        label: { zh: '默认返回条数', en: 'Default result count' },
        hint: { zh: '不指定 limit 时返回多少条。', en: 'How many results when no limit is given.' },
      },
      {
        path: 'retrieval.maxLimit',
        type: 'number',
        min: 1,
        max: 200,
        step: 1,
        unit: { zh: '条', en: 'results' },
        label: { zh: '最大返回条数', en: 'Maximum result count' },
        hint: { zh: '任何调用（含模型工具）都不能超过这个上限。', en: 'No caller, including tools, may exceed this cap.' },
      },
      {
        path: 'retrieval.minScore',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.01,
        label: { zh: '最低得分', en: 'Minimum score' },
        hint: { zh: '低于该分数的结果被丢弃；0 表示不丢弃。', en: 'Results below this score are dropped; 0 keeps all.' },
      },
      {
        path: 'retrieval.recencyHalfLifeDays',
        type: 'number',
        min: 1,
        max: 3650,
        step: 1,
        unit: { zh: '天', en: 'days' },
        label: { zh: '新鲜度半衰期', en: 'Recency half-life' },
        hint: { zh: '越小越偏向新记忆。', en: 'Smaller values favour newer memories.' },
      },
      {
        path: 'retrieval.forgetting.enabled',
        type: 'boolean',
        label: { zh: '遗忘曲线', en: 'Forgetting curve' },
        hint: { zh: '按最后访问时间衰减检索权重；关闭后只用新鲜度与重要度。', en: 'Decays retrieval weight by last access; off falls back to recency and importance.' },
      },
      {
        path: 'retrieval.forgetting.halfLifeDays',
        type: 'number',
        min: 1,
        max: 3650,
        step: 1,
        unit: { zh: '天', en: 'days' },
        label: { zh: '遗忘半衰期', en: 'Forgetting half-life' },
        hint: { zh: '超过这么久未访问，权重衰减到一半（再乘地板）。', en: 'Weight halves after this long without access, then applies the floor.' },
      },
      {
        path: 'retrieval.forgetting.floor',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '遗忘地板', en: 'Forgetting floor' },
        hint: { zh: '衰减下限，0.25 表示旧记忆最多保留 25% 权重。', en: 'Lower bound; 0.25 keeps at least 25% weight.' },
      },
      {
        path: 'retrieval.pinnedBoost',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '置顶加权', en: 'Pinned boost' },
        hint: { zh: '置顶记忆额外获得的分数（只影响空查询的列表排序）。', en: 'Extra score for pinned memories (listing order only).' },
      },
      {
        path: 'retrieval.semantic',
        type: 'boolean',
        label: { zh: '语义检索', en: 'Semantic retrieval' },
        hint: { zh: '对候选条目做向量余弦重排（哈希向量 + 原生批量计算），权重见下方混合权重。', en: 'Reranks candidates by vector cosine (hashed vectors + native batch math).' },
      },
      {
        path: 'retrieval.graph',
        type: 'boolean',
        label: { zh: '关系图谱', en: 'Relationship graph' },
        hint: { zh: '从命中结果出发做 BFS，把关联记忆带进结果。', en: 'Expands hits through graph edges with BFS.' },
      },
      {
        path: 'retrieval.weights.fulltext',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '权重：全文', en: 'Weight: full-text' },
        hint: { zh: 'FTS5 全文检索在最终得分里的占比（三项会自动归一化）。', en: 'Share of the final score from FTS5 full-text (weights normalise).' },
      },
      {
        path: 'retrieval.weights.semantic',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '权重：语义', en: 'Weight: semantic' },
        hint: { zh: '向量相似度在最终得分里的占比。', en: 'Share of the final score from vector similarity.' },
      },
      {
        path: 'retrieval.weights.graph',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '权重：图谱', en: 'Weight: graph' },
        hint: { zh: '图谱相关性在最终得分里的占比。', en: 'Share of the final score from graph relevance.' },
      },
      {
        path: 'retrieval.cacheSize',
        type: 'number',
        min: 16,
        max: 4096,
        step: 16,
        unit: { zh: '条', en: 'entries' },
        label: { zh: '检索缓存', en: 'Search cache' },
        hint: { zh: 'LRU 缓存多少组查询结果；写入会让缓存失效。', en: 'LRU cache size for query results; writes invalidate it.' },
      },
      {
        path: 'retrieval.graphDepth',
        type: 'number',
        min: 1,
        max: 3,
        step: 1,
        unit: { zh: '层', en: 'hops' },
        label: { zh: '图谱深度', en: 'Graph depth' },
        hint: { zh: 'BFS 最多扩张几层，相关度按 0.8^层数 衰减。', en: 'BFS hops; relevance decays 0.8 per hop.' },
      },
      {
        path: 'retrieval.graphSeeds',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        label: { zh: '图谱起点数', en: 'Graph seeds' },
        hint: { zh: '从得分最高的几条开始扩张。', en: 'How many top hits seed the expansion.' },
      },
      {
        path: 'retrieval.graphMinWeight',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '图谱最小边权', en: 'Graph min edge weight' },
        hint: { zh: '低于该权重的边不参与遍历。', en: 'Edges thinner than this are ignored.' },
      },
    ],
  },
  {
    id: 'write',
    title: { zh: '写入', en: 'Writing' },
    desc: { zh: '新建记忆时的默认行为', en: 'Defaults applied when creating memories' },
    fields: [
      {
        path: 'write.defaultImportance',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        label: { zh: '默认重要度', en: 'Default importance' },
        hint: { zh: '1–10，影响检索打分与提示词注入排序。', en: '1–10; drives ranking and prompt selection.' },
      },
      {
        path: 'write.minContentLength',
        type: 'number',
        min: 0,
        max: 200,
        step: 1,
        unit: { zh: '字', en: 'chars' },
        label: { zh: '正文最短长度', en: 'Minimum body length' },
        hint: { zh: '过短的写入被拒绝，避免记忆里塞满噪声。', en: 'Shorter writes are rejected to keep noise out.' },
      },
      {
        path: 'write.dedupeThreshold',
        type: 'number',
        min: 0.5,
        max: 1,
        step: 0.01,
        label: { zh: '去重相似度阈值', en: 'Duplicate similarity' },
        hint: { zh: '达到该相似度的新记忆会被标记为疑似重复。', en: 'A new memory this similar to an existing one is flagged.' },
      },
      {
        path: 'write.allowImmutableEdit',
        type: 'boolean',
        label: { zh: '允许智能体也修改不可变层', en: 'Also let the agent edit immutable layers' },
        hint: { zh: 'L0 / L1 / L3 对智能体默认只读（你本人在记忆面板里始终可改可删）；打开后智能体也能改，谨慎使用。', en: 'L0 / L1 / L3 are read-only for the agent (you can always edit them yourself); enabling this also unlocks them for the agent.' },
      },
      {
        path: 'write.defaultTtlDays',
        type: 'number',
        min: 1,
        max: 3650,
        step: 1,
        unit: { zh: '天', en: 'days' },
        label: { zh: '新建时的建议保鲜期', en: 'Suggested TTL' },
        hint: { zh: '新建表单的默认值；不是无限保鲜，最终仍以实际写入值为准。', en: 'Prefilled in the create form; the submitted value still wins.' },
      },
    ],
  },
  {
    id: 'layers',
    title: { zh: '分层开关', en: 'Layers' },
    desc: { zh: '逐层启用；关闭的层不参与写入与检索', en: 'Per-layer switches; disabled layers are excluded from writes and retrieval' },
    fields: LAYERS.map((layer) => ({
      path: `layers.${layer.id}`,
      type: 'boolean',
      label: { zh: `${layer.id} ${layer.name.zh}`, en: `${layer.id} ${layer.name.en}` },
      hint: layer.desc,
    })),
  },
  {
    id: 'prompt',
    title: { zh: '提示词注入', en: 'Prompt injection' },
    desc: { zh: '把长期记忆注入系统提示词；模板在记忆页顶部切换和自定义', en: 'Inject long-term memory; switch and edit templates at the top of the memory page' },
    fields: [
      {
        path: 'prompt.inject',
        type: 'boolean',
        label: { zh: '注入记忆摘要', en: 'Inject a memory digest' },
        hint: { zh: '开启后每次对话都会带上最重要的若干条记忆。', en: 'Each turn carries the most important memories.' },
      },
      {
        path: 'prompt.overrideBudget',
        type: 'boolean',
        label: { zh: '覆盖模板预算', en: 'Override template budget' },
        hint: { zh: '默认跟随模板的条数与字符上限；打开后才使用下面的条数/字符设置。', en: 'Follow the template budget unless this is on.' },
      },
      {
        path: 'prompt.topN',
        type: 'number',
        min: 0,
        max: 60,
        step: 1,
        unit: { zh: '条', en: 'entries' },
        label: { zh: '注入条数（覆盖）', en: 'Entries injected (override)' },
        hint: { zh: '仅在打开「覆盖模板预算」时生效。', en: 'Only used when overriding the template budget.' },
      },
      {
        path: 'prompt.maxChars',
        type: 'number',
        min: 0,
        max: 8000,
        step: 100,
        unit: { zh: '字符', en: 'chars' },
        label: { zh: '注入字符上限（覆盖）', en: 'Injection cap (override)' },
        hint: { zh: '仅在打开「覆盖模板预算」时生效；超出后截断。', en: 'Only used when overriding; text beyond it is truncated.' },
      },
    ],
  },
  {
    id: 'consolidation',
    title: { zh: '固化', en: 'Consolidation' },
    desc: { zh: '反复出现、更新或命中的记忆进入固化审计，由智能体确认后提升到稳定层', en: 'Repeated memories are audited and promoted after agent approval' },
    fields: [
      {
        path: 'consolidation.enabled',
        type: 'boolean',
        label: { zh: '启用固化审计', en: 'Enable consolidation audits' },
        hint: { zh: '维护任务会收集候选；关闭后不再产生新候选。', en: 'Maintenance collects candidates; off means no new candidates.' },
      },
      {
        path: 'consolidation.threshold',
        type: 'number',
        min: 2,
        max: 100,
        step: 1,
        unit: { zh: '次', en: 'signals' },
        label: { zh: '触发次数', en: 'Signal threshold' },
        hint: { zh: '窗口内写入、更新、检索命中累计达到该次数即成为候选。', en: 'Writes, updates and hits within the window that reach this count become candidates.' },
      },
      {
        path: 'consolidation.windowDays',
        type: 'number',
        min: 1,
        max: 365,
        step: 1,
        unit: { zh: '天', en: 'days' },
        label: { zh: '观察窗口', en: 'Observation window' },
        hint: { zh: '只统计最近这么多天内的强化信号。', en: 'Only signals inside this window count.' },
      },
      {
        path: 'consolidation.targetLayer',
        type: 'select',
        options: [
          { value: 'auto', label: { zh: '自动（思想 L2→L1，其余→L3）', en: 'Auto (thought L2→L1, others→L3)' } },
          { value: 'L1', label: { zh: 'L1 思想核心（不可变、永久）', en: 'L1 Core thoughts (immutable, permanent)' } },
          { value: 'L3', label: { zh: 'L3 本能行为（不可变、永久）', en: 'L3 Instincts (immutable, permanent)' } },
        ],
        label: { zh: '固化目标层', en: 'Consolidation target' },
        hint: { zh: '固化只进入不可变层，不再写保鲜期，也不会被清理。', en: 'Consolidation only moves items into immutable layers, with no TTL and no cleanup.' },
      },
      {
        path: 'consolidation.minImportance',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        label: { zh: '候选最低重要度', en: 'Minimum importance' },
        hint: { zh: '低于该重要度的条目不会进入固化候选。', en: 'Lower-importance entries are not proposed.' },
      },
      {
        path: 'consolidation.maxCandidates',
        type: 'number',
        min: 1,
        max: 200,
        step: 1,
        unit: { zh: '条', en: 'items' },
        label: { zh: '单次候选上限', en: 'Candidate cap' },
        hint: { zh: '每次审计最多列出这么多候选。', en: 'At most this many candidates per audit.' },
      },
      {
        path: 'consolidation.autoApply',
        type: 'boolean',
        label: { zh: '自动固化（危险）', en: 'Auto-apply (dangerous)' },
        hint: { zh: '默认关闭：必须由智能体审计确认。打开后维护任务会直接提升，不再等待确认。', en: 'Off by default: agent approval is required. On means maintenance promotes directly.' },
      },
    ],
  },
  {
    id: 'autoCapture',
    title: { zh: '自动记忆', en: 'Automatic capture' },
    desc: { zh: '在用户纠错、要求记住、情绪变化或智能体自省时提醒捕获；小/大定时回顾只入队提醒，是否写入由智能体判断', en: 'Nudge capture on corrections, remember requests, sentiment shifts or self-correction; hourly/daily reviews only queue a reminder, the agent decides what to write' },
    fields: [
      {
        path: 'autoCapture.enabled',
        type: 'boolean',
        label: { zh: '启用自动记忆', en: 'Enable automatic capture' },
        hint: { zh: '关闭后不检测信号、不排队回顾，memory_capture 也会拒绝写入。', en: 'When off, no signals or reviews are queued and memory_capture refuses writes.' },
      },
      {
        path: 'autoCapture.immediate',
        type: 'boolean',
        label: { zh: '即时信号', en: 'Immediate signals' },
        hint: { zh: '检测用户纠错/让记住/满意/不满，以及智能体自省。', en: 'Detect user corrections, remember requests, sentiment, and assistant self-correction.' },
      },
      {
        path: 'autoCapture.smallEnabled',
        type: 'boolean',
        label: { zh: '小时回顾', en: 'Hourly review' },
        hint: { zh: '按间隔提醒智能体回顾最近一段时间的对话。', en: 'Remind the agent to review the recent window on an interval.' },
      },
      {
        path: 'autoCapture.smallIntervalHours',
        type: 'number',
        min: 1,
        max: 168,
        step: 1,
        unit: { zh: '小时', en: 'h' },
        label: { zh: '小时回顾间隔', en: 'Hourly review interval' },
        hint: { zh: '两次小回顾之间的最短间隔。', en: 'Minimum gap between hourly reviews.' },
      },
      {
        path: 'autoCapture.smallWindowHours',
        type: 'number',
        min: 1,
        max: 168,
        step: 1,
        unit: { zh: '小时', en: 'h' },
        label: { zh: '小时回顾窗口', en: 'Hourly review window' },
        hint: { zh: '回顾最近多少小时的记忆与对话。', en: 'How many recent hours the review covers.' },
      },
      {
        path: 'autoCapture.largeEnabled',
        type: 'boolean',
        label: { zh: '每日回顾', en: 'Daily review' },
        hint: { zh: '每天固定时刻提醒一次整体表现回顾。', en: 'Remind once a day to review overall performance.' },
      },
      {
        path: 'autoCapture.largeAt',
        type: 'text',
        label: { zh: '每日回顾时刻', en: 'Daily review time' },
        hint: { zh: '24 小时制 HH:MM，例如 04:00。', en: '24-hour HH:MM, for example 04:00.' },
      },
      {
        path: 'autoCapture.largeLookbackDays',
        type: 'number',
        min: 1,
        max: 365,
        step: 1,
        unit: { zh: '天', en: 'd' },
        label: { zh: '每日回顾范围', en: 'Daily review window' },
        hint: { zh: '每日回顾覆盖最近多少天。', en: 'How many recent days the daily review covers.' },
      },
      {
        path: 'autoCapture.maxFacts',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        unit: { zh: '条', en: 'facts' },
        label: { zh: '单次事实上限', en: 'Facts per capture' },
        hint: { zh: '一次 memory_capture 最多提交多少条事实。', en: 'Maximum facts in one memory_capture call.' },
      },
      {
        path: 'autoCapture.maxNotes',
        type: 'number',
        min: 1,
        max: 20,
        step: 1,
        unit: { zh: '条', en: 'notes' },
        label: { zh: '单次笔记上限', en: 'Notes per capture' },
        hint: { zh: '一次 memory_capture 最多提交多少条笔记。', en: 'Maximum notes in one memory_capture call.' },
      },
      {
        path: 'autoCapture.noteDedupe',
        type: 'number',
        min: 0.5,
        max: 1,
        step: 0.01,
        label: { zh: '笔记去重阈值', en: 'Note dedupe threshold' },
        hint: { zh: '同一记事本内正文相似度达到该值即跳过；精确归一化匹配始终跳过。', en: 'Skip notes at or above this similarity within the same notebook; exact normalized matches always skip.' },
      },
      {
        path: 'autoCapture.queueKeep',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        unit: { zh: '条', en: 'items' },
        label: { zh: '待处理信号上限', en: 'Pending signal cap' },
        hint: { zh: '只保留最近这么多条未处理提醒。', en: 'Keep only this many unresolved reminders.' },
      },
      {
        path: 'autoCapture.adaptiveThrottle',
        type: 'boolean',
        label: { zh: '自适应限流', en: 'Adaptive throttling' },
        hint: {
          zh: '连续三次回顾都没写进任何条目时，把回顾间隔逐步拉长到最多 3 倍；一旦有产出就收回正常间隔。',
          en: 'When three reviews in a row save nothing, stretch the review interval up to 3x; any output returns it to normal.',
        },
      },
    ],
  },
  {
    id: 'hook',
    title: { zh: '写入审计 Hook', en: 'Write audit hook' },
    desc: { zh: '每次 memory_write / memory_update 前，由独立子智能体对照用户原话与长期价值做一次干净审计；更新时会对比新旧两版；失败时放行并记录', en: 'Before every memory write/update, an isolated subagent audits both evidence and long-term value, comparing old and new versions on updates; failures fail open and are recorded' },
    fields: [
      {
        path: 'hook.enabled',
        type: 'boolean',
        label: { zh: '启用写入审计', en: 'Enable write audit' },
        hint: { zh: '默认关闭。开启后每次写入会额外调用一次子智能体，并累计 token。', en: 'Off by default. Each write then starts one subagent and accumulates tokens.' },
      },
      {
        path: 'hook.enforce',
        type: 'boolean',
        label: { zh: '拦截高置信度拒绝', en: 'Block high-confidence rejects' },
        hint: { zh: '打开时拒绝会阻止写入；关闭时只记录为影子审计。', en: 'On blocks the write; off records a shadow audit only.' },
      },
      {
        path: 'hook.minConfidence',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '拦截置信度阈值', en: 'Block confidence threshold' },
        hint: { zh: '拒绝置信度低于该值时只提示，不拦截。', en: 'Rejects below this confidence are advisory only.' },
      },
      {
        path: 'hook.timeoutSeconds',
        type: 'number',
        min: 5,
        max: 180,
        step: 5,
        unit: { zh: '秒', en: 's' },
        label: { zh: '审计超时', en: 'Audit timeout' },
        hint: { zh: '超时按失败放行处理，并在审计页标记。', en: 'Timeouts fail open and are marked in the audit page.' },
      },
      {
        path: 'hook.maxRuns',
        type: 'number',
        min: 10,
        max: 500,
        step: 10,
        unit: { zh: '条', en: 'runs' },
        label: { zh: '审计记录上限', en: 'Audit run cap' },
        hint: { zh: '只保留最近这么多条审计记录与候选。', en: 'Keep only the most recent runs and candidates.' },
      },
    ],
  },
  {
    id: 'maintenance',
    title: { zh: '维护', en: 'Maintenance' },
    desc: { zh: '反思、冲突检测、轮转清理与归档', en: 'Reflection, conflict detection, rotation and archiving' },
    fields: [
      {
        path: 'maintenance.autoRun',
        type: 'boolean',
        label: { zh: '自动维护', en: 'Automatic maintenance' },
        hint: { zh: '按间隔在后台执行轮转清理与归档。', en: 'Runs rotation and archiving in the background.' },
      },
      {
        path: 'maintenance.intervalHours',
        type: 'number',
        min: 1,
        max: 168,
        step: 1,
        unit: { zh: '小时', en: 'hours' },
        label: { zh: '维护间隔', en: 'Maintenance interval' },
        hint: { zh: '自动维护两次之间的最短间隔。', en: 'Minimum gap between automatic runs.' },
      },
      {
        path: 'maintenance.ttlDays',
        type: 'number',
        min: 1,
        max: 3650,
        step: 1,
        unit: { zh: '天', en: 'days' },
        label: { zh: '默认保鲜期', en: 'Default TTL' },
        hint: { zh: 'L6 / L7 未指定保鲜期时使用。', en: 'Used by L6 / L7 when no TTL is given.' },
      },
      {
        path: 'maintenance.archiveAfterDays',
        type: 'number',
        min: 1,
        max: 3650,
        step: 1,
        unit: { zh: '天', en: 'days' },
        label: { zh: '归档阈值', en: 'Archive after' },
        hint: { zh: '低重要度记忆超过该天数未更新则归档。', en: 'Low-importance memories untouched for this long are archived.' },
      },
      {
        path: 'maintenance.promoteAccessCount',
        type: 'number',
        min: 1,
        max: 100,
        step: 1,
        unit: { zh: '次', en: 'hits' },
        label: { zh: '提升所需命中次数', en: 'Promotion hits' },
        hint: { zh: '被检索命中这么多次后建议提升分层。', en: 'Suggested for promotion after this many hits.' },
      },
      {
        path: 'maintenance.conflictThreshold',
        type: 'number',
        min: 0.5,
        max: 1,
        step: 0.01,
        label: { zh: '冲突相似度阈值', en: 'Conflict similarity' },
        hint: { zh: 'L2 中两条记忆相似度达到该值时标记冲突。', en: 'L2 entries this similar are flagged as conflicting.' },
      },
      {
        path: 'maintenance.autoPromote',
        type: 'boolean',
        label: { zh: '自动提升', en: 'Promote automatically' },
        hint: { zh: '关闭时只在维护报告里给出建议。', en: 'When off, promotions are only reported.' },
      },
      {
        path: 'maintenance.auditKeep',
        type: 'number',
        min: 0,
        max: 5000,
        step: 50,
        unit: { zh: '条', en: 'entries' },
        label: { zh: '审计日志保留', en: 'Audit log size' },
        hint: { zh: '保留最近多少条操作记录；0 表示不记录。', en: 'How many operations to keep; 0 disables.' },
      },
      {
        path: 'maintenance.diffKeep',
        type: 'number',
        min: 0,
        max: 10000,
        step: 100,
        unit: { zh: '条', en: 'changes' },
        label: { zh: '变更历史保留', en: 'Change history size' },
        hint: { zh: 'diff 查询使用的结构化变更记录上限；与审计日志分开保留。', en: 'Structured change entries kept for diff queries, retained separately from the audit log.' },
      },
      {
        path: 'maintenance.rotateMinImportance',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '轮转阈值', en: 'Rotation threshold' },
        hint: { zh: 'L6/L7 条目按原生重要性评分低于该值即过期清理。', en: 'L6/L7 entries whose native importance score is below this expire.' },
      },
      {
        path: 'maintenance.maxItems',
        type: 'number',
        min: 100,
        max: 1000000,
        step: 100,
        unit: { zh: '条', en: 'items' },
        label: { zh: '条目上限', en: 'Item limit' },
        hint: { zh: '超过后维护任务会清理最旧的轮转记忆，收到上限的 90%。', en: 'Maintenance trims the oldest rotating memories down to 90% of this cap.' },
      },
      {
        path: 'maintenance.historyKeep',
        type: 'number',
        min: 1,
        max: 200,
        step: 1,
        unit: { zh: '次', en: 'runs' },
        label: { zh: '维护历史保留', en: 'Maintenance history' },
        hint: { zh: '维护面板保留最近多少次运行记录。', en: 'How many recent maintenance runs the panel keeps.' },
      },
      {
        path: 'maintenance.slowQueryMs',
        type: 'number',
        min: 0,
        max: 60000,
        step: 10,
        unit: { zh: '毫秒', en: 'ms' },
        label: { zh: '慢查询阈值', en: 'Slow query threshold' },
        hint: { zh: '检索耗时达到该值写入慢查询日志；0 表示记录全部查询。', en: 'Searches at or above this are recorded; 0 logs every search.' },
      },
      {
        path: 'maintenance.slowQueryKeep',
        type: 'number',
        min: 0,
        max: 500,
        step: 10,
        unit: { zh: '条', en: 'entries' },
        label: { zh: '慢查询保留', en: 'Slow query log size' },
        hint: { zh: '只保留最近这么多条慢查询；0 表示关闭记录。', en: 'Keep this many slow queries; 0 disables logging.' },
      },
      // 保留策略按「层」与「记事本」各给一组天数：超过这么久没更新就归档。
      // 0 表示不设，条目仍按全局 archiveAfterDays 的规则处理，不会因为默认值被误伤。
      ...[
        ['L2', 'L2 演进想法', 'L2 evolving thoughts'],
        ['L4', 'L4 项目学习', 'L4 project learnings'],
        ['L5', 'L5 目标偏好', 'L5 goals and preferences'],
        ['L6', 'L6 短期事实', 'L6 short-lived facts'],
        ['L7', 'L7 当前情境', 'L7 current context'],
      ].map(([layer, zh, en]) => ({
        path: `maintenance.retention.byLayer.${layer}`,
        type: 'number',
        min: 0,
        max: 3650,
        step: 10,
        unit: { zh: '天', en: 'days' },
        label: { zh: `保留 ${zh}`, en: `Keep ${en}` },
        hint: {
          zh: '超过这么多天没更新就归档该层条目；0 表示不设。',
          en: 'Archive entries of this layer untouched for this long; 0 means unset.',
        },
      })),
      ...[
        ['memory', '记忆本', 'memory notebook'],
        ['daily', '日志本', 'daily notebook'],
        ['asset', '资料本', 'asset notebook'],
        ['pitfall', '踩坑本', 'pitfall notebook'],
      ].map(([notebook, zh, en]) => ({
        path: `maintenance.retention.byNotebook.${notebook}`,
        type: 'number',
        min: 0,
        max: 3650,
        step: 10,
        unit: { zh: '天', en: 'days' },
        label: { zh: `保留 ${zh}`, en: `Keep ${en}` },
        hint: {
          zh: '超过这么多天没更新就归档该记事本条目；0 表示不设。',
          en: 'Archive notes in this notebook untouched for this long; 0 means unset.',
        },
      })),
    ],
  },
  {
    id: 'performance',
    title: { zh: '性能', en: 'Performance' },
    desc: { zh: '原生计算核心与并发', en: 'Native compute core and concurrency' },
    fields: [
      {
        path: 'performance.nativeCore',
        type: 'boolean',
        label: { zh: '启用原生计算核心（Rust）', en: 'Enable the native compute core (Rust)' },
        hint: { zh: '批量余弦相似度、重要性评分、去重交给 memory-core；关掉或二进制缺失时用纯 JS 兜底。', en: 'Batch cosine, importance scoring and dedupe run in memory-core; off or missing binary falls back to JS.' },
      },
    ],
  },
  {
    id: 'privacy',
    title: { zh: '隐私', en: 'Privacy' },
    desc: { zh: '本地数据与审计', en: 'Local data and auditing' },
    fields: [
      {
        path: 'privacy.auditLog',
        type: 'boolean',
        label: { zh: '记录操作审计', en: 'Record an audit log' },
        hint: { zh: '写入、修改、删除都会留下一条本地记录。', en: 'Writes, edits and deletes leave a local record.' },
      },
    ],
  },
  {
    id: 'tools',
    title: { zh: '模型工具', en: 'Model tools' },
    desc: { zh: '暴露给模型的记忆工具', en: 'Memory tools exposed to the model' },
    fields: [
      {
        path: 'tools.enabled',
        type: 'boolean',
        label: { zh: '启用记忆工具', en: 'Enable memory tools' },
        hint: { zh: '关闭后模型看不到 memory_* 工具，只能靠提示词注入。', en: 'When off, the model no longer sees the memory_* tools.' },
      },
    ],
  },
]

/** 扁平字段表（校验与默认值遍历用）。 */
export const SETTINGS_FIELDS = SETTINGS_SCHEMA.flatMap((group) => group.fields)

export const SORT_CHOICES = SORT_OPTIONS

/** 读取点分路径。 */
export function getPath(target, path) {
  if (target === null || typeof target !== 'object') return undefined
  let current = target
  for (const key of String(path).split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** 写入点分路径（就地修改）。 */
export function setPath(target, path, value) {
  const keys = String(path).split('.')
  let current = target
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]
    if (current[key] === null || typeof current[key] !== 'object') current[key] = {}
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
  return target
}

export function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

/** 把一个候选值收敛成字段合法值；不合法返回 `undefined`。 */
export function coerceField(field, value) {
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (field.type === 'number') {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return undefined
    let next = field.step !== undefined && field.step < 1 ? parsed : Math.round(parsed)
    if (field.min !== undefined) next = Math.max(field.min, next)
    if (field.max !== undefined) next = Math.min(field.max, next)
    return next
  }
  if (field.type === 'select') {
    const options = field.options ?? []
    return options.some((option) => option.value === value) ? value : undefined
  }
  if (field.type === 'text' || field.type === 'textarea') {
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/**
 * 从任意来源的 patch / 完整对象里收敛出一份合法设置。
 * 未提供或非法的字段取默认值 —— 因此传入 `{}` 就是"恢复出厂"。
 */
export function normalizeSettings(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const next = clone(DEFAULT_SETTINGS)
  for (const field of SETTINGS_FIELDS) {
    const candidate = getPath(source, field.path)
    if (candidate === undefined) continue
    const value = coerceField(field, candidate)
    if (value !== undefined) setPath(next, field.path, value)
  }
  // 旧版本的默认下限是 0.5，而自动建出来的 related 边权重是真实余弦（0.22-0.9），
  // 留着 0.5 会把它们全部过滤掉。只有「正好等于旧默认值」时才跟着调整，
  // 用户自己填过的数值不动。
  if (getPath(next, 'retrieval.graphMinWeight') === 0.5
    && getPath(source, 'retrieval.graphMinWeight') === 0.5) {
    setPath(next, 'retrieval.graphMinWeight', 0.22)
  }
  // 模板不是 schema 里的静态下拉：自定义模板 + 当前模板 id 必须整体保留。
  next.prompt.customTemplates = normalizeCustomTemplates(source.prompt?.customTemplates)
  const requestedTemplate = source.prompt?.template
  if (typeof requestedTemplate === 'string' && allTemplates(next).some((template) => template.id === requestedTemplate)) {
    next.prompt.template = requestedTemplate
  }
  return next
}

/**
 * 把设置页提交的 patch 合并进当前设置：只接受 schema 里声明过的路径，
 * 非法值被忽略（而不是把整份设置清空）。
 */
export function applySettingsPatch(current, patch) {
  const base = normalizeSettings(current ?? {})
  if (patch === null || typeof patch !== 'object') return base
  for (const field of SETTINGS_FIELDS) {
    if (!(field.path in flatten(patch))) continue
    const candidate = getPath(patch, field.path)
    const value = coerceField(field, candidate)
    if (value !== undefined) setPath(base, field.path, value)
  }
  // 兼容旧客户端：模板切换以前走 settings.save 的 prompt.template。
  const requestedTemplate = getPath(patch, 'prompt.template')
  if (typeof requestedTemplate === 'string'
    && allTemplates(base).some((template) => template.id === requestedTemplate)) {
    base.prompt.template = requestedTemplate
  }
  return base
}

/** 点分路径是否出现在 patch 里（区分"未提供"和"提供了 false"）。 */
function flatten(patch, prefix = '', out = {}) {
  if (patch === null || typeof patch !== 'object') return out
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    out[path] = true
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out)
  }
  return out
}

/** 该分层当前是否可用。 */
export function layerEnabled(settings, layerId) {
  const value = getPath(settings, `layers.${layerId}`)
  return value !== false
}

/** 某分层的定义。 */
export function layerInfo(layerId) {
  return LAYERS.find((layer) => layer.id === layerId) ?? LAYERS[5]
}

/**
 * Cordis 的 config 校验钩子（Standard Schema）。
 *
 * 永不抛错：`validate` 抛错会让这一行激活失败，而激活失败在桌面端可能触发
 * 安全模式看门狗。非法值一律回退默认值并在 Host 日志里提示。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-memory-plugin',
    validate(value) {
      return { value: normalizeSettings(value ?? {}) }
    },
  },
}
