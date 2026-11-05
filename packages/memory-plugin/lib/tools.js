/**
 * 模型可调用的记忆工具。
 *
 * 这些工具和设置页调用的是同一个引擎实例（lib/engine.js），所以"用户在界面里看到的"
 * 和"模型读到的"永远是同一份数据。
 */
import { TOOL_NAMES } from './engine.js'
import { LAYERS, NOTEBOOKS } from './settings.js'
import { message } from './store.js'

const LAYER_ENUM = LAYERS.map((layer) => layer.id)

const itemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['memory', 'note'] },
    layer: { type: 'string', enum: LAYER_ENUM },
    layerName: { type: 'string' },
    notebook: { type: ['string', 'null'], enum: [...NOTEBOOKS.map((notebook) => notebook.id), null] },
    title: { type: 'string' },
    content: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    importance: { type: 'number' },
    status: { type: 'string' },
    pinned: { type: 'boolean' },
    expiresAt: { type: ['string', 'null'] },
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
      duplicateOf: { type: ['string', 'null'] },
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
      byLayer: { type: 'object', additionalProperties: { type: 'number' } },
      byStatus: { type: 'object', additionalProperties: { type: 'number' } },
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

/**
 * 注册全部工具，返回释放函数。
 * ctx.tools.register(definition, options) 的 definition 必须带 output。
 */
export function registerTools(ctx, engine, log) {
  const disposers = []
  const register = (definition) => {
    try {
      disposers.push(ctx.tools.register(definition))
    } catch (error) {
      log('warn', `注册工具 ${definition.name} 失败：${message(error)}`)
    }
  }

  register({
    name: 'memory_write',
    description: 'Save a durable memory or notebook entry for later sessions. Use it for user preferences, project facts, decisions and anything worth recalling after this conversation. Prefer one focused fact per call.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or note to keep, in the user\'s language.' },
        title: { type: 'string', description: 'Short title. Generated from content when omitted.' },
        layer: { type: 'string', enum: LAYER_ENUM, description: 'Memory layer. Defaults to the configured default (L5 目标记忆). Use L6 for items that should expire.' },
        type: { type: 'string', enum: ['memory', 'note'], description: 'memory = long-term memory, note = notebook entry.' },
        notebook: { type: 'string', enum: NOTEBOOKS.map((notebook) => notebook.id), description: 'Notebook id, only for type=note.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short tags for retrieval.' },
        importance: { type: 'number', description: '1-10, default 5. Higher means it survives longer and ranks higher.' },
        ttlDays: { type: 'number', description: 'Optional expiry in days; L6/L7 default to the configured TTL.' },
      },
      required: ['content'],
    },
    output: writeOutput,
    async execute(args, exec) {
      const item = engine.createItem({
        ...args,
        sessionId: sessionIdOf(exec),
      }, 'agent')
      return { saved: true, item, duplicateOf: item.duplicateOf ?? null }
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
      return engine.searchItems(args ?? {})
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
      return { item }
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
        layer: { type: 'string', enum: LAYER_ENUM },
        status: { type: 'string', enum: ['active', 'archived', 'expired', 'conflicted'] },
        pinned: { type: 'boolean', description: 'Pinned items are never auto-archived or auto-expired.' },
        ttlDays: { type: 'number' },
      },
      required: ['id'],
    },
    output: updateOutput,
    async execute(args) {
      const { id, ...patch } = args ?? {}
      const item = engine.updateItem(String(id ?? ''), patch, 'agent')
      return { item }
    },
  })

  register({
    name: 'memory_delete',
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
      return engine.deleteItems(args?.ids ?? [], 'agent')
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

function clip(value, max) {
  const source = String(value ?? '').replace(/\s+/g, ' ').trim()
  return source.length <= max ? source : `${source.slice(0, max)}…`
}

function sessionIdOf(exec) {
  const candidate = exec?.sessionId ?? exec?.session?.id ?? exec?.agent?.sessionId
  return typeof candidate === 'string' ? candidate : null
}

export { TOOL_NAMES }
