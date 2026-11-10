/**
 * 模型可调用的记忆工具。
 *
 * 这些工具和设置页调用的是同一个引擎实例（lib/engine.js），所以"用户在界面里看到的"
 * 和"模型读到的"永远是同一份数据。
 */
import { TOOL_NAMES } from './engine.js'
import { CAPTURE_TRIGGERS, captureLabel } from './capture.js'
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
    questions: { type: 'array', items: { type: 'string' } },
    importance: { type: 'number' },
    status: { type: 'string' },
    pinned: { type: 'boolean' },
    expiresAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    key: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    source: { type: 'object', additionalProperties: true },
    supersedes: { type: 'array', items: { type: 'string' } },
    supersededBy: { oneOf: [{ type: 'string' }, { type: 'null' }] },
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

const notesOutput = {
  schema: {
    type: 'object',
    properties: {
      total: { type: 'number' },
      items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      groups: { type: 'array', items: { type: 'object', additionalProperties: true } },
      totalNotes: { type: 'number' },
    },
    required: ['total', 'items'],
  },
  render(args, value) {
    const items = value?.items ?? []
    if (items.length === 0) {
      const notebook = String(args?.notebook ?? '')
      return text(notebook === ''
        ? '记事本里没有匹配的条目。'
        : `记事本 ${notebook} 里没有匹配的条目。`)
    }
    const groups = (value?.groups ?? [])
      .map((group) => `${group.name ?? group.id}（${group.count} 条）`)
      .join('，')
    const lines = items.map((item, index) => {
      const mark = item.referenced === true ? '★ ' : ''
      return `${index + 1}. ${mark}${item.title}\n   ${clip(item.summary, 120)}\n   id: ${item.id} · ${item.notebookName ?? item.notebook}`
    })
    return text([
      `记事本共 ${value?.totalNotes ?? 0} 条；分类：${groups === '' ? '（无）' : groups}`,
      `命中 ${value?.total ?? items.length} 条，显示前 ${items.length} 条：`,
      ...lines,
      '',
      '★ 是被索引条目引用的细节。要正文就用 memory_get(id) 取全文。',
    ].join('\n'))
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
      Array.isArray(item.questions) && item.questions.length > 0 ? `能回答：${item.questions.join(' / ')}` : '',
      item.key !== null && item.key !== undefined ? `实体键：${item.key}` : '',
      item.source?.quote ? `来源原话：${clip(item.source.quote, 300)}` : '',
      item.supersededBy ? `已被 ${item.supersededBy} 取代` : '',
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

const pitfallOutput = {
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      item: { oneOf: [itemSchema, { type: 'null' }] },
      items: { type: 'array', items: itemSchema },
      total: { type: 'number' },
      found: { type: 'boolean' },
      query: { type: 'string' },
      advice: { type: 'string' },
    },
    required: [],
  },
  render(args, value) {
    const action = String(args?.action ?? 'search')
    if (action === 'record') {
      const item = value?.item
      return text(item === undefined || item === null
        ? '踩坑笔记未保存。'
        : `已记录踩坑「${item.title}」到 ${item.layer}（${item.layerName}），id: ${item.id}。`)
    }
    if (action === 'check') {
      const items = value?.items ?? []
      if (value?.found !== true) return text(`没有找到相关历史踩坑。\n${value?.advice ?? ''}`.trim())
      return text(`找到 ${items.length} 条相关踩坑，先复用已有解决办法：\n`
        + items.map((item, index) => `${index + 1}. ${item.title}\n   现象：${clip(item.pitfall?.problem || item.content, 160)}\n   解决：${clip(item.pitfall?.solution || '（见正文）', 220)}\n   id: ${item.id}`).join('\n'))
    }
    const items = value?.items ?? []
    if (items.length === 0) return text(`没有找到与「${String(args?.query ?? '')}」相关的踩坑笔记。`)
    return text(`踩坑笔记 ${value?.total ?? items.length} 条，显示 ${items.length} 条：\n`
      + items.map((item, index) => `${index + 1}. ${item.title} [${item.layer}]\n   现象：${clip(item.pitfall?.problem || item.content, 140)}\n   解决：${clip(item.pitfall?.solution || '（见正文）', 180)}\n   id: ${item.id}`).join('\n'))
  },
}

const linkOutput = {
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      id: { type: 'string' },
      count: { type: 'number' },
      links: { type: 'array', items: { type: 'object', additionalProperties: true } },
      link: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
      removed: { type: 'number' },
    },
    required: ['action'],
  },
  render(args, value) {
    const action = String(value?.action ?? args?.action ?? 'list')
    if (action === 'link') {
      const link = value?.link
      if (link === undefined || link === null) return text('关联未建立。')
      return text(`已建立人工关联：${String(value?.id ?? '')} ↔ ${String(link.id ?? '')}`
        + `（权重 ${Number(link.weight ?? 1).toFixed(2)}）`)
    }
    if (action === 'unlink') return text(`已解除关联 ${value?.removed ?? 0} 条。`)
    const links = value?.links ?? []
    if (links.length === 0) return text(`条目 ${String(value?.id ?? '')} 还没有关联条目。`)
    return text(`条目 ${String(value?.id ?? '')} 有 ${links.length} 条关联：\n`
      + links.map((link, index) => {
        const title = typeof link.title === 'string' && link.title !== '' ? link.title : String(link.id ?? '')
        return `${index + 1}. ${title}（${String(link.edgeType ?? 'manual')} · ${Number(link.weight ?? 1).toFixed(2)}）\n   id: ${String(link.id ?? '')}`
      }).join('\n'))
  },
}

const diffOutput = {
  schema: {
    type: 'object',
    properties: {
      range: { type: 'object', additionalProperties: true },
      filters: { type: 'object', additionalProperties: true },
      total: { type: 'number' },
      offset: { type: 'number' },
      limit: { type: 'number' },
      counts: { type: 'object', additionalProperties: true },
      changes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      retention: { type: 'object', additionalProperties: true },
    },
    required: ['total', 'changes'],
  },
  render(args, value) {
    const changes = value?.changes ?? []
    const range = value?.range ?? {}
    if (changes.length === 0) {
      return text(`时间范围 ${range.since ?? '?'} → ${range.until ?? '?'} 内没有变更记录。`)
    }
    return text(`时间范围 ${range.since ?? '?'} → ${range.until ?? '?'}：共 ${value?.total ?? changes.length} 条变更`
      + `（显示 ${changes.length} 条，保留 ${value?.retention?.kept ?? '?'}/${value?.retention?.limit ?? '?'} 条）：\n`
      + changes.map((change, index) => {
        const where = change.layer !== '' ? `${change.layer}${change.notebook ? `·${change.notebook}` : ''}` : change.notebook ?? ''
        return `${index + 1}. ${change.at} [${change.operation}] ${change.entity === 'note' ? '笔记' : '记忆'} ${change.title}`
          + `${where !== '' ? `（${where}）` : ''}\n   ${change.summary ?? ''}\n   id: ${change.itemId}  操作者: ${change.actor}`
      }).join('\n'))
  },
}

const captureOutput = {
  schema: {
    type: 'object',
    properties: {
      saved: { type: 'boolean' },
      trigger: { type: 'string' },
      created: { type: 'number' },
      skipped: { type: 'number' },
      errors: { type: 'number' },
      pending: { type: 'number' },
    },
    required: ['saved', 'trigger', 'created', 'skipped', 'errors', 'pending'],
  },
  render(args, value) {
    const trigger = captureLabel(value?.trigger, 'zh')
    return text(`自动记忆（${trigger}）：新建 ${value?.created ?? 0} 条，跳过 ${value?.skipped ?? 0} 条，失败 ${value?.errors ?? 0} 条；待处理信号 ${value?.pending ?? 0} 条。`)
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
    description: 'Save a durable memory or notebook entry for later sessions. Use it for user preferences, project facts, decisions and anything worth recalling after this conversation. Decide the mutable layer yourself from the meaning of the content; there is no server-side default layer. Prefer one focused fact per call. For L4 learning items and L5 todos: keep the body to one line, put the detail in a notebook entry (type=note), then link it with refs and set indexMode=true, so the detail loads only when it is needed.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or note to keep, in the user\'s language.' },
        title: { type: 'string', description: 'Short title. Generated from content when omitted.' },
        layer: {
          type: 'string',
          enum: WRITABLE_LAYER_ENUM,
          description: 'Choose the layer yourself by meaning: L2 evolving thoughts, L4 project learnings, L5 todos/in-progress work, L6 short-lived facts, L7 current context. Required; immutable L0/L1/L3 are not writable.',
        },
        type: { type: 'string', enum: ['memory', 'note'], description: 'memory = long-term memory, note = notebook entry.' },
        notebook: { type: 'string', enum: NOTEBOOKS.map((notebook) => notebook.id), description: 'Notebook id, only for type=note.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short tags for retrieval.' },
        questions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 4 short questions this memory can answer, phrased the way the user would actually ask (for example "我怎么才能不把钱花超"). Write them from the source wording, never copy the answer. They are indexed with the same weight as the title, so this is the main lever for being recalled later.',
        },
        importance: { type: 'number', description: '1-10, default 5. Higher means it survives longer and ranks higher.' },
        ttlDays: {
          type: 'number',
          description: 'Freshness period in days. Required for every memory in a mutable layer (writes fail without it). Choose according to how long the fact stays true; notes ignore it.',
        },
        key: {
          type: 'string',
          description: 'Stable entity key (for example "user/editor" or "project/build-command"). Writing the same key again updates the existing entry instead of creating a duplicate.',
        },
        quote: {
          type: 'string',
          description: 'Short verbatim quote from the user or source that justifies this memory.',
        },
        workspace: {
          type: 'string',
          description: 'Project space. Defaults to the current working directory; pass an empty string to store a global memory visible in every project.',
        },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of older entries this one replaces. They are archived and hidden from normal retrieval.',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Notebook entry ids that hold the details of this memory. An index entry keeps one line here and lets the detail load only when it is needed.',
        },
        indexMode: {
          type: 'boolean',
          description: 'Render this memory as a one-line pointer at injection time: the body stays short and the details live in the linked notebook entries (refs).',
        },
      },
      required: ['content', 'layer'],
    },
    output: writeOutput,
    async execute(args, exec) {
      const item = await engine.createItem({
        ...args,
        workspace: args.workspace === undefined ? workspaceOf(exec) : args.workspace,
        sessionId: sessionIdOf(exec),
        turn: typeof exec?.turn === 'number' ? exec.turn : undefined,
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
        workspace: {
          type: 'string',
          description: 'Project space filter. Defaults to the current working directory; pass "*" to search every project.',
        },
      },
      required: ['query'],
    },
    output: searchOutput,
    async execute(args, exec) {
      const result = await engine.searchItems({
        ...(args ?? {}),
        workspace: args?.workspace === undefined ? workspaceOf(exec) : args.workspace,
        actor: 'agent',
      })
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
    async execute(args, exec) {
      const item = engine.getItem(String(args?.id ?? ''), workspaceOf(exec))
      if (item === undefined) throw new Error(`找不到条目 ${String(args?.id ?? '')}`)
      return { item: toToolItem(item) }
    },
  })

  register({
    name: 'memory_notes',
    description: 'List notebook entries (index only, not full bodies) so you can pick which id to open. The prompt only carries a per-notebook count, so call this first when you need a notebook detail, then use memory_get(id) for the full text. This is the first step of progressive loading.',
    parameters: {
      type: 'object',
      properties: {
        notebook: { type: 'string', enum: NOTEBOOKS.map((notebook) => notebook.id), description: 'Restrict to one notebook. Omit to list every notebook.' },
        keyword: { type: 'string', description: 'Filter by title, body or tag, in the user\'s language.' },
        limit: { type: 'number', description: 'How many entries to return (1-200, default 20).' },
        offset: { type: 'number', description: 'Skip this many entries, for paging.' },
        sort: { type: 'string', enum: ['updated', 'created', 'importance', 'title'], description: 'Sort order, default updated.' },
        workspace: {
          type: 'string',
          description: 'Project space filter. Defaults to the current working directory; pass "*" to list every project.',
        },
      },
    },
    output: notesOutput,
    async execute(args, exec) {
      const result = engine.notesIndex({
        ...(args ?? {}),
        workspace: args?.workspace === undefined ? workspaceOf(exec) : args.workspace,
        actor: 'agent',
      })
      return result
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
        questions: { type: 'array', items: { type: 'string' }, description: 'Replace the stored questions (up to 4).' },
        importance: { type: 'number', description: '1-10.' },
        layer: { type: 'string', enum: WRITABLE_LAYER_ENUM, description: 'Move to another mutable layer when the meaning changes.' },
        status: { type: 'string', enum: ['active', 'archived', 'expired', 'conflicted'] },
        pinned: { type: 'boolean', description: 'Pinned items are never auto-archived or auto-expired.' },
        ttlDays: {
          type: 'number',
          description: 'Freshness period in days. Required when changing title/content/tags/importance/layer of a mutable memory; the new expiry starts from now.',
        },
        key: { type: 'string', description: 'Change the stable entity key; conflicts with another active entry in the same layer are rejected.' },
        quote: { type: 'string', description: 'Short verbatim quote that justifies this update.' },
        supersedes: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of older entries this update replaces; they are archived and hidden.',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace the notebook entry ids this entry points to (the details behind an index entry).',
        },
        indexMode: { type: 'boolean', description: 'Turn the one-line pointer rendering of this entry on or off.' },
      },
      required: ['id'],
    },
    output: updateOutput,
    async execute(args, exec) {
      const { id, ...patch } = args ?? {}
      const itemId = String(id ?? '')
      if (engine.getItem(itemId, workspaceOf(exec)) === undefined) throw new Error(`找不到条目 ${itemId}`)
      if (typeof exec?.turn === 'number') patch.turn = exec.turn
      const item = await engine.updateItem(itemId, patch, 'agent')
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
    async execute(args, exec) {
      const ids = Array.isArray(args?.ids) ? args.ids : []
      const scope = workspaceOf(exec)
      for (const id of ids) {
        if (engine.getItem(String(id), scope) === undefined) throw new Error(`找不到条目 ${String(id)}`)
      }
      return await engine.deleteItems(ids, 'agent')
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
    name: 'memory_pitfall',
    description: 'Record, search or check historical pitfalls (mistakes, root causes and reusable fixes) so the same problem is not solved twice. Use action=check before debugging a familiar error, action=record after solving a new one.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['record', 'search', 'check'], description: 'record a new pitfall; search/list pitfalls; check whether a task or error has a known pitfall.' },
        query: { type: 'string', description: 'Task, error message or keywords. Required for search/check.' },
        problem: { type: 'string', description: 'What happened / the symptom. Required for record.' },
        cause: { type: 'string', description: 'Root cause, if known.' },
        solution: { type: 'string', description: 'The fix or workaround. Required for record.' },
        prevention: { type: 'string', description: 'How to avoid it next time.' },
        title: { type: 'string', description: 'Short title; defaults to the problem.' },
        layer: { type: 'string', enum: WRITABLE_LAYER_ENUM, description: 'Defaults to L4.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags; “踩坑” is added automatically.' },
        limit: { type: 'number', description: 'Max results (1-50, default 10; check defaults to 5).' },
      },
      required: ['action'],
    },
    output: pitfallOutput,
    async execute(args) {
      const action = String(args?.action ?? 'search')
      if (action === 'record') {
        return { action, ...(await engine.recordPitfall(args ?? {}, 'agent')) }
      }
      if (action === 'search') {
        const result = await engine.searchPitfalls({ ...(args ?? {}), actor: 'agent' })
        return { action, ...result, items: result.items.map(toToolItem) }
      }
      if (action === 'check') {
        const result = await engine.checkPitfalls(args ?? {})
        return { action, ...result, items: result.items.map(toToolItem) }
      }
      throw new Error('action 只能是 record、search 或 check')
    },
  })

  register({
    name: 'memory_link',
    description: 'Inspect and edit manual links between memories and notebook entries. Automatic links only follow literal overlap, so two entries that describe the same thing in different words stay apart, and a wrong automatic neighbour cannot be corrected. Use action=list to see the links of one entry, action=link to connect two entries you have judged to be the same thread, action=unlink to drop a link you judged wrong. Manual links survive automatic rebuilds and are written to the audit log.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'link', 'unlink'],
          description: 'list = show the links of `id`; link / unlink = edit the link between `id` and `targetId`.',
        },
        id: { type: 'string', description: 'Entry id returned by memory_search or memory_write.' },
        targetId: { type: 'string', description: 'The other entry id, required for link and unlink.' },
        weight: { type: 'number', description: 'Optional 0-1 strength for link; default 1.' },
        limit: { type: 'number', description: 'How many links to list, 1-30, default 10.' },
      },
      required: ['action', 'id'],
    },
    output: linkOutput,
    async execute(args, exec) {
      const action = String(args?.action ?? 'list')
      const id = String(args?.id ?? '')
      if (id === '') throw new Error('需要 id：先用 memory_search 找到条目')
      if (action === 'list') {
        const raw = await engine.itemLinks(id, { limit: Number(args?.limit) || 10 })
        const links = raw.map((link) => {
          const other = engine.getItem(String(link.id ?? ''), workspaceOf(exec))
          return {
            id: String(link.id ?? ''),
            edgeType: String(link.edgeType ?? 'manual'),
            weight: Number(link.weight ?? 1),
            title: other?.title ?? '',
            layer: other?.layer ?? null,
          }
        })
        return { action, id, count: links.length, links }
      }
      const targetId = String(args?.targetId ?? '')
      if (targetId === '') throw new Error('需要 targetId：要连到哪一条')
      if (action === 'link') {
        const link = await engine.linkItems({ sourceId: id, targetId, weight: args?.weight }, 'agent')
        return { action, id, targetId, link: { id: String(link?.id ?? targetId), weight: Number(link?.weight ?? 1) } }
      }
      if (action === 'unlink') {
        const result = await engine.unlinkItems({ sourceId: id, targetId }, 'agent')
        return { action, id, targetId, removed: Number(result?.removed ?? 0) }
      }
      throw new Error('action 只能是 list、link 或 unlink')
    },
  })

  register({
    name: 'memory_diff',
    description: 'Show what changed in memories and notebooks during a time range, optionally filtered by entity type, memory layer, item id or operation. Reads the structured change history; use it to review recent updates or reconcile conflicting context.',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO time or date lower bound; default 7 days ago.' },
        until: { type: 'string', description: 'ISO time or date upper bound; default now.' },
        entity: { type: 'string', enum: ['memory', 'note', 'all'], description: 'Restrict to memories, notebooks, or all.' },
        layer: { type: 'string', enum: LAYER_ENUM, description: 'Restrict to one memory layer.' },
        itemId: { type: 'string', description: 'Restrict to one item.' },
        operation: { type: 'string', description: 'create/update/delete/bulk/consolidate.' },
        limit: { type: 'number', description: 'Page size 1-200, default 50.' },
        offset: { type: 'number', description: 'Pagination offset.' },
        includeContent: { type: 'boolean', description: 'Include full before/after content; default only a 240-char preview.' },
      },
    },
    output: diffOutput,
    async execute(args) {
      return engine.diff(args ?? {})
    },
  })

  register({
    name: 'memory_capture',
    description: 'Capture facts and notebook entries detected by the automatic-memory triggers. Call it when the user corrects you, asks you to remember, shows clear satisfaction or dissatisfaction, or when you notice your own mistake; hourly/daily review prompts use it too. You must choose each fact layer and TTL yourself. Notebook entries are deduplicated by code within the same notebook. Pass outcome "nothing" after reviewing a signal if nothing is worth keeping.',
    parameters: {
      type: 'object',
      properties: {
        trigger: { type: 'string', enum: CAPTURE_TRIGGERS, description: 'What triggered this capture.' },
        pendingId: { type: 'string', description: 'Pending signal id shown in the prompt; it is cleared after a successful capture.' },
        outcome: { type: 'string', enum: ['captured', 'nothing'], description: 'Use "nothing" after reviewing a signal when nothing should be saved.' },
        summary: { type: 'string', description: 'Short reason or review conclusion, stored in the capture run.' },
        facts: {
          type: 'array',
          description: 'Durable facts. layer and ttlDays are required for mutable memory layers; choose them from the content, not a fixed default.',
          items: {
            type: 'object',
            properties: {
              layer: { type: 'string', enum: WRITABLE_LAYER_ENUM },
              title: { type: 'string' },
              content: { type: 'string' },
              ttlDays: { type: 'number' },
              importance: { type: 'number' },
              tags: { type: 'array', items: { type: 'string' } },
              questions: { type: 'array', items: { type: 'string' }, description: 'Up to 4 questions this fact can answer, in the user phrasing.' },
              key: { type: 'string' },
              workspace: { type: 'string' },
              reason: { type: 'string', description: 'Why this fact/layer/TTL was chosen; kept as the source quote.' },
            },
            required: ['layer', 'content'],
          },
        },
        notes: {
          type: 'array',
          description: 'Notebook entries; code deduplicates same-notebook content before writing.',
          items: {
            type: 'object',
            properties: {
              notebook: { type: 'string', enum: NOTEBOOK_IDS },
              title: { type: 'string' },
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              questions: { type: 'array', items: { type: 'string' }, description: 'Up to 4 questions this note can answer, in the user phrasing.' },
              importance: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['notebook', 'content'],
          },
        },
      },
      required: ['trigger'],
    },
    output: captureOutput,
    async execute(args, exec) {
      const workspace = workspaceOf(exec)
      const result = await engine.capture({
        ...(args ?? {}),
        sessionId: sessionIdOf(exec),
        workspace,
      }, 'agent')
      return {
        saved: result.created.length > 0 || result.skipped.length > 0,
        trigger: result.run.trigger,
        created: result.created.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
        pending: result.pending,
      }
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
  const candidate = exec?.sessionId ?? exec?.session?.id ?? exec?.agent?.session?.id ?? exec?.agent?.sessionId
  return typeof candidate === 'string' ? candidate : null
}

function workspaceOf(exec) {
  const candidate = exec?.workspace ?? exec?.cwd ?? exec?.agent?.workspace
    ?? exec?.agent?.session?.cwd ?? exec?.agent?.session?.workspace
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined
}

export { TOOL_NAMES }




