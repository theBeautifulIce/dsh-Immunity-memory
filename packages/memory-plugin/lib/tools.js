/**
 * 模型可调用的记忆工具。
 *
 * 这些工具和设置页调用的是同一个引擎实例（lib/engine.js），所以"用户在界面里看到的"
 * 和"模型读到的"永远是同一份数据。
 */
import { TOOL_NAMES } from './engine.js'
import { LAYERS, NOTEBOOKS, NOTEBOOK_IDS } from './settings.js'
import { message } from './store.js'

const LAYER_ENUM = LAYERS.map((layer) => layer.id)
const WRITABLE_LAYER_ENUM = LAYERS.filter((layer) => layer.immutable !== true).map((layer) => layer.id)

const itemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['memory', 'note'] },
    layer: { type: 'string', enum: LAYER_ENUM },
    layerName: { type: 'string' },
    // 输出 schema 只接受单值 type（JsonSchemaNode），可空字段用 oneOf 表达。
    notebook: { oneOf: [{ type: 'string', enum: NOTEBOOK_IDS }, { type: 'null' }] },
    title: { type: 'string' },
    content: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    importance: { type: 'number' },
    status: { type: 'string' },
    pinned: { type: 'boolean' },
    expiresAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    updatedAt: { type: 'string' },
    accessCount: { type: 'number' },
    score: { type: 'number' },
  },
  required: ['id', 'title', 'layer'],
}

const writeOutput = {
  schema: {
    type: 'object',
    properties: {
      item: itemSchema,
      duplicateOf: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      saved: { type: 'boolean' },
    },
    required: ['saved'],
  },
  render(args, value) {
    const item = value?.item
    if (item === undefined) return text(`没有保存任何内容：${String(args?.content ?? '').slice(0, 80)}`)
    const tags = item.tags.length > 0 ? `，标签 ${item.tags.join('/')}` : ''
    return text(`已保存到 ${item.layer}（${item.layerName}）：${item.title}（重要度 ${item.importance}${tags}）`
      + (value?.duplicateOf ? `\n注意：与已有记忆 ${value.duplicateOf} 高度相似，可能重复。` : '')
      + `\nid: ${item.id}`)
  },
}

const searchOutput = {
  schema: {
    type: 'object',
    properties: {
      total: { type: 'number' },
      items: { type: 'array', items: itemSchema },
    },
    required: ['total', 'items'],
  },
  render(args, value) {
    const items = value?.items ?? []
    if (items.length === 0) return text(`没有找到与「${String(args?.query ?? '')}」相关的记忆。`)
    const lines = items.map((item, index) => {
      const score = typeof item.score === 'number' ? ` 得分 ${item.score}` : ''
      return `${index + 1}. [${item.layer}·${item.layerName}·重要度${item.importance}] ${item.title}${score}\n   ${clip(item.content, 200)}\n   id: ${item.id}`
    })
    return text(`命中 ${value?.total ?? items.length} 条，显示前 ${items.length} 条：\n${lines.join('\n')}`)
  },
}

const getOutput = {
  schema: {
    type: 'object',
    properties: { item: itemSchema },
    required: ['item'],
  },
  render(args, value) {
    const item = value?.item
    if (item === undefined) return text(`找不到条目 ${String(args?.id ?? '')}`)
    return text([
      `# ${item.title}`,
      `分层：${item.layer}（${item.layerName}）  类型：${item.type}  重要度：${item.importance}  状态：${item.status}`,
      `标签：${item.tags.length > 0 ? item.tags.join('、') : '（无）'}`,
      `创建：${item.createdAt}  更新：${item.updatedAt}  访问：${item.accessCount} 次`,
      item.expiresAt !== null ? `到期：${item.expiresAt}` : '',
      '',
      item.content,
    ].filter((line) => line !== '').join('\n'))
  },
}

const updateOutput = {
  schema: {
    type: 'object',
    properties: { item: itemSchema },
    required: ['item'],
  },
  render(args, value) {
    const item = value?.item
    if (item === undefined) return text(`没有更新任何内容（${String(args?.id ?? '')}）`)
    return text(`已更新 ${item.id}：${item.title}（重要度 ${item.importance}，状态 ${item.status}）`)
  },
}

const deleteOutput = {
  schema: {
    type: 'object',
    properties: {
      deleted: { type: 'number' },
      ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['deleted'],
  },
  render(args, value) {
    return text(`已删除 ${value?.deleted ?? 0} 条记忆。`)
  },
}

const statsOutput = {
  schema: {
    type: 'object',
    properties: {
      total: { type: 'number' },
      memories: { type: 'number' },
      notes: { type: 'number' },
      byLayer: { type: 'object', additionalProperties: true },
      byStatus: { type: 'object', additionalProperties: true },
      averageImportance: { type: 'number' },
      writes: { type: 'number' },
      searches: { type: 'number' },
    },
    required: ['total'],
  },
  render(args, value) {
    const layers = Object.entries(value?.byLayer ?? {})
      .filter(([, count]) => count > 0)
      .map(([layer, count]) => `${layer} ${count}`)
      .join('，')
    return text([
      `共 ${value?.total ?? 0} 条（记忆 ${value?.memories ?? 0} / 记事 ${value?.notes ?? 0}）`,
      `分层分布：${layers === '' ? '空' : layers}`,
      `平均重要度 ${value?.averageImportance ?? 0}，累计写入 ${value?.writes ?? 0} 次，检索 ${value?.searches ?? 0} 次`,
    ].join('\n'))
  },
}

const usageOutput = {
  schema: {
    type: 'object',
    properties: {
      calls: { type: 'number' },
      queryTokens: { type: 'number' },
      resultTokens: { type: 'number' },
      totalTokens: { type: 'number' },
      allTime: { type: 'object', additionalProperties: true },
      byTool: { type: 'object', additionalProperties: true },
      byType: { type: 'object', additionalProperties: true },
      recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    required: ['calls', 'totalTokens'],
  },
  render(args, value) {
    const type = value?.filters?.type ?? '全部'
    return text([
      `智能体查询记事本/记忆的 token 用量（${type}）`,
      `调用 ${value?.calls ?? 0} 次：查询 ${value?.queryTokens ?? 0} + 结果 ${value?.resultTokens ?? 0} = ${value?.totalTokens ?? 0} token`,
      `累计：${value?.allTime?.calls ?? 0} 次，${(value?.allTime?.queryTokens ?? 0) + (value?.allTime?.resultTokens ?? 0)} token`,
      value?.recent?.length > 0
        ? `最近一次：${value.recent[0].tool} / ${value.recent[0].type} / ${value.recent[0].totalTokens ?? (value.recent[0].queryTokens + value.recent[0].resultTokens)} token`
        : '还没有带过滤条件的用量记录。',
    ].join('\n'))
  },
}

const consolidateOutput = {
  schema: {
    type: 'object',
    properties: {
      candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
      decision: { type: 'string' },
      item: itemSchema,
      record: { type: 'object', additionalProperties: true },
    },
    required: [],
  },
  render(args, value) {
    if (Array.isArray(value?.candidates)) {
      if (value.candidates.length === 0) return text('当前没有达到阈值的固化候选。')
      return text(`固化候选 ${value.candidates.length} 条（需智能体审计后 approve/reject）：\n`
        + value.candidates.map((candidate, index) => `${index + 1}. ${candidate.id} [${candidate.layer}] ${candidate.title}`
          + `，信号 ${candidate.signals} 次（写入 ${candidate.breakdown?.create ?? 0}/更新 ${candidate.breakdown?.update ?? 0}/命中 ${candidate.breakdown?.hit ?? 0}）`
          + ` → 建议 ${candidate.suggestedLayer}（永久，不再过期）`).join('\n'))
    }
    if (value?.decision === 'approve') {
      return text(`已固化 ${value.item?.id}：${value.record?.fromLayer} → ${value.record?.toLayer}（不可变、永久），已写入审计。`)
    }
    if (value?.decision === 'reject') {
      return text(`已记录拒绝固化 ${value.item?.id}；出现新的强化信号后会重新进入候选。`)
    }
    return text('固化操作完成。')
  },
}

/**
 * 注册全部工具，返回释放函数。
 * ctx.tools.register(definition, options) 的 definition 必须带 output。
 */
export function registerTools(ctx, engine, log) {
  const disposers = []
  const register = (definition) => {
    try {
      // 工具的返回值必须是无损 JSON：undefined / 函数 / NaN 都要先清掉，
      // 否则宿主会拒收（"value is not lossless JSON"），模型看到的是工具失败。
      const wrapped = {
        ...definition,
        async execute(args, exec) {
          return toLossless(await definition.execute(args, exec))
        },
      }
      disposers.push(ctx.tools.register(wrapped))
    } catch (error) {
      log('warn', `注册工具 ${definition.name} 失败：${message(error)}`)
    }
  }

  register({
    name: 'memory_write',
    description: 'Save a durable memory or notebook entry for later sessions. Use it for user preferences, project facts, decisions and anything worth recalling after this conversation. Decide the mutable layer yourself from the meaning of the content; there is no server-side default layer. Prefer one focused fact per call.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or note to keep, in the user\'s language.' },
        title: { type: 'string', description: 'Short title. Generated from content when omitted.' },
        layer: {
          type: 'string',
          enum: WRITABLE_LAYER_ENUM,
          description: 'Choose the layer yourself by meaning: L2 evolving thoughts, L4 project learnings, L5 goals/preferences, L6 short-lived facts, L7 current context. Required; immutable L0/L1/L3 are not writable.',
        },
        type: { type: 'string', enum: ['memory', 'note'], description: 'memory = long-term memory, note = notebook entry.' },
        notebook: { type: 'string', enum: NOTEBOOKS.map((notebook) => notebook.id), description: 'Notebook id, only for type=note.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short tags for retrieval.' },
        importance: { type: 'number', description: '1-10, default 5. Higher means it survives longer and ranks higher.' },
        ttlDays: {
          type: 'number',
          description: 'Freshness period in days. Required for every memory in a mutable layer (writes fail without it). Choose according to how long the fact stays true; notes ignore it.',
        },
      },
      required: ['content', 'layer'],
    },
    output: writeOutput,
    async execute(args, exec) {
      const item = await engine.createItem({
        ...args,
        sessionId: sessionIdOf(exec),
      }, 'agent')
      return { saved: true, item: toToolItem(item), duplicateOf: item.duplicateOf ?? null }
    },
  })

  register({
    name: 'memory_search',
    description: 'Search long-term memory and notebooks by keywords. Call it before assuming the user has no prior context on a topic. Chinese and English both work.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, in the user\'s language.' },
        limit: { type: 'number', description: 'How many results to return (1-50).' },
        layer: { type: 'string', enum: LAYER_ENUM, description: 'Restrict to one layer.' },
        type: { type: 'string', enum: ['memory', 'note'], description: 'Restrict to memories or notebook entries.' },
        status: { type: 'string', enum: ['active', 'archived', 'conflicted', 'all'], description: 'Default active.' },
      },
      required: ['query'],
    },
    output: searchOutput,
    async execute(args) {
      const result = await engine.searchItems({ ...(args ?? {}), actor: 'agent' })
      return { ...result, items: result.items.map(toToolItem) }
    },
  })

  register({
    name: 'memory_get',
    description: 'Read one memory or notebook entry in full by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Item id returned by memory_search or memory_write.' } },
      required: ['id'],
    },
    output: getOutput,
    async execute(args) {
      const item = engine.getItem(String(args?.id ?? ''))
      if (item === undefined) throw new Error(`找不到条目 ${String(args?.id ?? '')}`)
      return { item: toToolItem(item) }
    },
  })

  register({
    name: 'memory_update',
    description: 'Update an existing memory: correct a fact, change importance, move it to another layer, archive it or add tags.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item id.' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        importance: { type: 'number', description: '1-10.' },
        layer: { type: 'string', enum: WRITABLE_LAYER_ENUM, description: 'Move to another mutable layer when the meaning changes.' },
        status: { type: 'string', enum: ['active', 'archived', 'expired', 'conflicted'] },
        pinned: { type: 'boolean', description: 'Pinned items are never auto-archived or auto-expired.' },
        ttlDays: {
          type: 'number',
          description: 'Freshness period in days. Required when changing title/content/tags/importance/layer of a mutable memory; the new expiry starts from now.',
        },
      },
      required: ['id'],
    },
    output: updateOutput,
    async execute(args) {
      const { id, ...patch } = args ?? {}
      const item = await engine.updateItem(String(id ?? ''), patch, 'agent')
      return { item: toToolItem(item) }
    },
  })

  register({
    name: 'memory_forget',
    description: 'Delete memories by id. Use it when the user asks to forget something or a memory is provably wrong.',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'One or more item ids.' },
      },
      required: ['ids'],
    },
    output: deleteOutput,
    async execute(args) {
      return await engine.deleteItems(args?.ids ?? [], 'agent')
    },
  })

  register({
    name: 'memory_usage',
    description: 'Report how many tokens the agent spent querying memory and notebooks: query tokens, returned result tokens, totals by tool/type and recent calls.',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO date/time lower bound, e.g. 2026-11-01.' },
        tool: { type: 'string', description: 'Filter by tool name, e.g. memory_search.' },
        type: { type: 'string', enum: ['memory', 'note'], description: 'Filter by queried content type.' },
      },
    },
    output: usageOutput,
    async execute(args) {
      return engine.usageStats(args ?? {})
    },
  })

  register({
    name: 'memory_consolidate',
    description: 'Review and act on memory consolidation: list candidates that were repeatedly written, updated or retrieved, then approve moving a stable fact into L1 core thoughts or L3 instincts (both immutable and permanent), or reject it. Every decision is audited.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'approve', 'reject'], description: 'list = show pending candidates; approve/reject = record an audited decision.' },
        id: { type: 'string', description: 'Candidate item id (required for approve/reject).' },
        targetLayer: { type: 'string', enum: ['L1', 'L3'], description: 'L1 core thoughts or L3 instincts; both immutable and permanent. Defaults to auto by source layer.' },
        note: { type: 'string', description: 'Audit note: why it should or should not be consolidated.' },
      },
      required: ['action'],
    },
    output: consolidateOutput,
    async execute(args) {
      const action = String(args?.action ?? 'list')
      if (action === 'list') {
        return { candidates: engine.consolidationCandidates({ limit: args?.limit }) }
      }
      if (action !== 'approve' && action !== 'reject') throw new Error('action 只能是 list、approve 或 reject')
      const id = String(args?.id ?? '')
      if (id === '') throw new Error('approve/reject 必须提供 id')
      return await engine.applyConsolidation(id, action, {
        targetLayer: args?.targetLayer,
        note: args?.note,
      }, 'agent')
    },
  })

  register({
    name: 'memory_stats',
    description: 'Report how many memories exist, how they are distributed across layers and how often memory was written or searched.',
    parameters: { type: 'object', properties: {} },
    output: statsOutput,
    async execute() {
      const stats = engine.stats()
      return stats
    },
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 释放失败不应阻塞卸载
      }
    }
    disposers.length = 0
  }
}

function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * 工具的条目视图：把双语的分层名压成模型友好的单语字符串
 * （`layerName` 在输出 schema 里声明为 string，直接透传 { zh, en } 会被宿主判为不匹配）。
 */
export function toToolItem(item) {
  if (item === null || typeof item !== 'object') return item
  const label = item.layerName
  return {
    ...item,
    layerName: typeof label === 'string' ? label : label?.zh ?? label?.en ?? '',
  }
}

/**
 * 把任意返回值收敛成"无损 JSON"：
 *   - `undefined` / 函数 / symbol → 丢弃（数组里则变成 null）
 *   - `NaN` / `Infinity` → null
 *   - Date → ISO 字符串
 *   - 其余原始值、数组、普通对象递归处理
 * 宿主的工具结果校验只接受这种形状。
 */
export function toLossless(value) {
  if (value === undefined || value === null) return null
  const kind = typeof value
  if (kind === 'function' || kind === 'symbol') return null
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind === 'bigint') return String(value)
  if (kind !== 'object') return value
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) return value.map((entry) => toLossless(entry))
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    if (typeof entry === 'function' || typeof entry === 'symbol') continue
    out[key] = toLossless(entry)
  }
  return out
}

function clip(value, max) {
  const source = String(value ?? '').replace(/\s+/g, ' ').trim()
  return source.length <= max ? source : `${source.slice(0, max)}…`
}

function sessionIdOf(exec) {
  const candidate = exec?.sessionId ?? exec?.session?.id ?? exec?.agent?.sessionId
  return typeof candidate === 'string' ? candidate : null
}

export { TOOL_NAMES }




