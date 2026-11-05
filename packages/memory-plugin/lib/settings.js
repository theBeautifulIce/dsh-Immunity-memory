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
  { id: 'memory', name: { zh: '记忆记事本', en: 'Memory notes' }, desc: { zh: '值得长期保留的事实与线索', en: 'Facts worth keeping' } },
  { id: 'daily', name: { zh: '日常记事本', en: 'Daily notes' }, desc: { zh: '按日期记录的工作日志', en: 'Dated work log' } },
  { id: 'asset', name: { zh: '资产记事本', en: 'Asset notes' }, desc: { zh: '路径、账号、配置等可复用资产', en: 'Paths, accounts and reusable assets' } },
]

export const NOTEBOOK_IDS = NOTEBOOKS.map((notebook) => notebook.id)

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
    dir: '',
    backupKeep: 3,
  },
  retrieval: {
    defaultLimit: 8,
    maxLimit: 50,
    minScore: 0.15,
    recencyHalfLifeDays: 30,
    pinnedBoost: 0.25,
  },
  write: {
    minContentLength: 8,
    dedupeThreshold: 0.9,
    defaultLayer: 'L5',
    defaultImportance: 5,
    allowImmutableEdit: false,
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
    topN: 6,
    maxChars: 1200,
  },
  maintenance: {
    autoRun: true,
    intervalHours: 6,
    ttlDays: 30,
    archiveAfterDays: 180,
    promoteAccessCount: 3,
    conflictThreshold: 0.82,
    auditKeep: 200,
    autoPromote: false,
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

const LAYER_OPTIONS = LAYERS.map((layer) => ({ value: layer.id, label: layer.name }))

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
        hint: { zh: '每次保存前轮转一份 store.bak-N.json；0 表示不备份。', en: 'Rotate a store.bak-N.json before each save; 0 disables.' },
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
        path: 'retrieval.pinnedBoost',
        type: 'number',
        min: 0,
        max: 1,
        step: 0.05,
        label: { zh: '置顶加权', en: 'Pinned boost' },
        hint: { zh: '置顶记忆额外获得的分数。', en: 'Extra score for pinned memories.' },
      },
    ],
  },
  {
    id: 'write',
    title: { zh: '写入', en: 'Writing' },
    desc: { zh: '新建记忆时的默认行为', en: 'Defaults applied when creating memories' },
    fields: [
      {
        path: 'write.defaultLayer',
        type: 'select',
        options: LAYER_OPTIONS,
        label: { zh: '默认分层', en: 'Default layer' },
        hint: { zh: '模型调用 memory_write 且未指定分层时使用。', en: 'Used when memory_write omits the layer.' },
      },
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
        label: { zh: '允许修改不可变层', en: 'Allow editing immutable layers' },
        hint: { zh: 'L0 / L1 / L3 默认只读；打开后解锁（谨慎使用）。', en: 'L0 / L1 / L3 are read-only by default; this unlocks them.' },
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
    desc: { zh: '把长期记忆注入系统提示词', en: 'Inject long-term memory into the system prompt' },
    fields: [
      {
        path: 'prompt.inject',
        type: 'boolean',
        label: { zh: '注入记忆摘要', en: 'Inject a memory digest' },
        hint: { zh: '开启后每次对话都会带上最重要的若干条记忆。', en: 'Each turn carries the most important memories.' },
      },
      {
        path: 'prompt.topN',
        type: 'number',
        min: 0,
        max: 30,
        step: 1,
        unit: { zh: '条', en: 'entries' },
        label: { zh: '注入条数', en: 'Entries injected' },
        hint: { zh: '按重要度、置顶与新鲜度排序取前 N 条。', en: 'Top N by importance, pinning and recency.' },
      },
      {
        path: 'prompt.maxChars',
        type: 'number',
        min: 0,
        max: 8000,
        step: 100,
        unit: { zh: '字符', en: 'chars' },
        label: { zh: '注入字符上限', en: 'Injection character cap' },
        hint: { zh: '超出后截断，防止记忆挤占上下文。', en: 'Truncated beyond this budget.' },
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
