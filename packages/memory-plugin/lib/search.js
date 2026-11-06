/**
 * 混合检索引擎（对应设计文档 §5.1 / §5.5）。
 *
 *   查询 → 基础索引（FTS5 / 内存倒排）
 *        → 语义索引（哈希向量 + 原生批量余弦）
 *        → 关系图谱（BFS，按边权衰减 0.8）
 *        → 融合排序（权重可配，默认 0.4 / 0.4 / 0.2）
 *
 * 设计要点：
 *   - 先用索引裁剪候选，再只对候选算分：查询成本跟"命中量"走，不跟库大小走；
 *   - 基础检索优先 SQLite FTS5（C 实现 + bm25），JSON 存储时退回内存倒排索引；
 *   - 语义重排把候选向量打包成矩阵，交给原生核心批量算余弦（不可用时 JS 兜底）；
 *   - 图谱只在命中结果的前几个节点上扩张，避免全图遍历；
 *   - 结果带 `breakdown`（fulltext / semantic / graph / final），便于调试和界面展示。
 */
import { DEFAULT_DIM, embed, packMatrix } from './embeddings.js'
import { ftsText, jaccard, tokenCounts, tokenize } from './text.js'

function clamp(value, min = 0, max = 1) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

/** 简单 LRU：键 → 值，超过容量淘汰最久未用。 */
function createLru(capacity) {
  const map = new Map()
  const limit = Math.max(8, Math.min(4096, Math.trunc(capacity) || 256))
  return {
    get(key) {
      if (!map.has(key)) return undefined
      const value = map.get(key)
      map.delete(key)
      map.set(key, value)
      return value
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > limit) {
        const oldest = map.keys().next().value
        map.delete(oldest)
      }
    },
    clear() {
      map.clear()
    },
    get size() {
      return map.size
    },
  }
}

/**
 * 内存倒排索引 + BM25 打分。
 *
 * 为什么不用 FTS5：DSH 宿主自带的 node:sqlite 编译时没有启用 FTS5
 * （`no such module: fts5`）。倒排索引在内存里维护，查询只遍历命中的 postings，
 * 复杂度与命中量成正比；BM25 和 FTS5 的 bm25() 是同一套公式，换库只改实现不改接口。
 */
function createInvertedIndex() {
  const postings = new Map()
  const tokensOf = new Map()
  const lengths = new Map()
  let totalLength = 0

  const remove = (id) => {
    const counts = tokensOf.get(id)
    if (counts === undefined) return
    for (const token of counts.keys()) {
      const bucket = postings.get(token)
      if (bucket === undefined) continue
      bucket.delete(id)
      if (bucket.size === 0) postings.delete(token)
    }
    totalLength -= lengths.get(id) ?? 0
    lengths.delete(id)
    tokensOf.delete(id)
  }

  const add = (item) => {
    remove(item.id)
    const counts = tokenCounts(ftsText(item))
    tokensOf.set(item.id, counts)
    let length = 0
    for (const count of counts.values()) length += count
    lengths.set(item.id, length || 1)
    totalLength += length || 1
    for (const [token, count] of counts) {
      if (!postings.has(token)) postings.set(token, new Map())
      postings.get(token).set(item.id, count)
    }
  }

  const rebuild = (items) => {
    postings.clear()
    tokensOf.clear()
    lengths.clear()
    totalLength = 0
    for (const item of items) add(item)
  }

  /**
   * BM25 查询（k1=1.2, b=0.75）。返回 [{ id, rank }]，rank 按本次最高分归一化到 0..1。
   */
  const search = (queryTokens, limit = 400, options = {}) => {
    if (queryTokens.size === 0) return []
    const k1 = options.k1 ?? 1.2
    const b = options.b ?? 0.75
    const docCount = lengths.size
    if (docCount === 0) return []
    const averageLength = totalLength / docCount || 1
    const scores = new Map()
    for (const token of queryTokens) {
      const bucket = postings.get(token)
      if (bucket === undefined) continue
      const df = bucket.size
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
      for (const [id, tf] of bucket) {
        const length = lengths.get(id) ?? 1
        const weight = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (length / averageLength))))
        scores.set(id, (scores.get(id) ?? 0) + weight)
      }
    }
    const maxScore = scores.size === 0 ? 0 : Math.max(...scores.values())
    const out = []
    for (const [id, score] of scores) out.push({ id, rank: maxScore > 0 ? score / maxScore : 0 })
    out.sort((left, right) => right.rank - left.rank)
    return out.slice(0, limit)
  }

  return { add, remove, rebuild, search, get size() { return postings.size }, get docs() { return lengths.size } }
}

/**
 * 创建检索引擎。
 *
 * @param {{ store: object, native: object, getSettings: () => object, log: Function }} options
 */
export function createSearchEngine({ store, native, getSettings, log }) {
  const index = createInvertedIndex()
  const vectorCache = new Map()
  let cache = createLru(getSettings()?.retrieval?.cacheSize ?? 256)
  let version = 0
  let counters = { searches: 0, totalMs: 0, cacheHits: 0, cacheMisses: 0, indexQueries: 0, semanticQueries: 0, graphQueries: 0 }

  const settings = () => getSettings() ?? {}
  const weights = () => {
    const configured = settings().retrieval?.weights ?? {}
    const fulltext = clamp(configured.fulltext ?? 0.4)
    const semantic = clamp(configured.semantic ?? 0.4)
    const graph = clamp(configured.graph ?? 0.2)
    const sum = fulltext + semantic + graph
    if (sum <= 0) return { fulltext: 1 / 3, semantic: 1 / 3, graph: 1 / 3 }
    return { fulltext: fulltext / sum, semantic: semantic / sum, graph: graph / sum }
  }

  const vectorOf = (item) => {
    const signature = `${item.updatedAt ?? ''}|${item.version ?? 1}`
    const cached = vectorCache.get(item.id)
    if (cached !== undefined && cached.signature === signature) return cached.vector
    const vector = embed(ftsText(item), DEFAULT_DIM)
    vectorCache.set(item.id, { signature, vector })
    return vector
  }

  const bump = () => {
    version += 1
    cache.clear()
  }

  const graphNeighbors = (id, options = {}) => {
    const db = store.raw?.()
    if (db === undefined) return []
    try {
      const minWeight = options.minWeight ?? 0.5
      const rows = db.prepare(
        `SELECT source_id, target_id, edge_type, weight FROM relationships
         WHERE (source_id = ? OR target_id = ?) AND weight >= ? LIMIT ?`,
      ).all(id, id, minWeight, options.limit ?? 64)
      return rows.map((row) => ({
        id: row.source_id === id ? row.target_id : row.source_id,
        edgeType: row.edge_type,
        weight: row.weight,
      }))
    } catch {
      return []
    }
  }

  const search = async (options) => {
    const started = Date.now()
    const config = settings()
    const query = String(options.query ?? '').trim()
    const tokens = tokenize(query)
    const limit = Math.max(1, Math.min(options.limit ?? config.retrieval?.defaultLimit ?? 10, config.retrieval?.maxLimit ?? 50))
    const cacheKey = JSON.stringify({
      v: version,
      q: query,
      limit,
      layer: options.layer ?? null,
      type: options.type ?? null,
      status: options.status ?? null,
      notebook: options.notebook ?? null,
      tags: options.tags ?? null,
      semantic: config.retrieval?.semantic !== false,
      graph: config.retrieval?.graph !== false,
      weights: weights(),
    })
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      counters.cacheHits += 1
      counters.searches += 1
      counters.totalMs += Date.now() - started
      return { ...cached, cached: true, tookMs: Date.now() - started }
    }
    counters.cacheMisses += 1

    const items = options.items
    const allow = (item) => {
      if (item === undefined) return false
      if (options.layer !== undefined && item.layer !== options.layer) return false
      if (options.type !== undefined && item.type !== options.type) return false
      if (options.notebook !== undefined && item.notebook !== options.notebook) return false
      if (options.status === 'usable') {
        if (item.status !== 'active' && item.status !== 'conflicted') return false
      } else if (options.status !== undefined && options.status !== 'all' && item.status !== options.status) return false
      if ((options.status === 'usable' || options.status === 'active' || options.status === 'conflicted')
        && (item.duplicateOf !== null && item.duplicateOf !== undefined
          || item.supersededBy !== null && item.supersededBy !== undefined)) {
        return false
      }
      if (Array.isArray(options.tags) && options.tags.length > 0) {
        const wanted = options.tags.map((tag) => String(tag).toLowerCase())
        const have = (item.tags ?? []).map((tag) => String(tag).toLowerCase())
        if (!wanted.every((tag) => have.includes(tag))) return false
      }
      return true
    }

    // 1) 基础索引：内存倒排 + BM25（宿主 SQLite 没有 FTS5，见文件头注释）
    const basic = index.search(tokens, 400)
    counters.indexQueries += 1
    const fulltext = new Map()
    for (const hit of basic) {
      if (allow(items.get(hit.id))) fulltext.set(hit.id, clamp(hit.rank))
    }

    // 2) 语义索引：只对候选算余弦
    const semanticScores = new Map()
    if (config.retrieval?.semantic !== false && fulltext.size > 0) {
      counters.semanticQueries += 1
      const candidates = [...fulltext.keys()]
      const entries = []
      if (store.engine === 'sqlite' && store.vectors) {
        for (const [id, vector] of store.vectorsFor(candidates)) entries.push([id, vector])
      }
      const known = new Set(entries.map(([id]) => id))
      for (const id of candidates) {
        if (known.has(id)) continue
        entries.push([id, vectorOf(items.get(id))])
      }
      if (entries.length > 0) {
        const queryVector = embed(query, DEFAULT_DIM)
        const matrix = packMatrix(entries, DEFAULT_DIM)
        const scores = await native.cosine(queryVector, matrix, entries.length, DEFAULT_DIM)
        for (let offset = 0; offset < entries.length; offset += 1) {
          semanticScores.set(entries[offset][0], Math.max(0, scores[offset]))
        }
      }
    }

    // 3) 关系图谱：从得分最高的若干节点扩张
    const graphScores = new Map()
    if (config.retrieval?.graph !== false && fulltext.size > 0) {
      counters.graphQueries += 1
      const seeds = [...fulltext.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, config.retrieval?.graphSeeds ?? 5)
        .map(([id]) => id)
      const depth = Math.max(1, Math.min(3, config.retrieval?.graphDepth ?? 2))
      const minWeight = clamp(config.retrieval?.graphMinWeight ?? 0.5)
      const seen = new Set(seeds)
      let frontier = seeds.map((id) => ({ id, relevance: 1 }))
      for (let level = 0; level < depth; level += 1) {
        const next = []
        for (const node of frontier) {
          for (const neighbor of graphNeighbors(node.id, { minWeight })) {
            if (seen.has(neighbor.id)) continue
            seen.add(neighbor.id)
            const relevance = node.relevance * neighbor.weight * 0.8
            if (relevance <= 0.05) continue
            graphScores.set(neighbor.id, Math.max(graphScores.get(neighbor.id) ?? 0, relevance))
            next.push({ id: neighbor.id, relevance })
          }
        }
        frontier = next
        if (frontier.length === 0) break
      }
      for (const [id, score] of graphScores) {
        if (!fulltext.has(id) && allow(items.get(id))) fulltext.set(id, 0)
      }
    }

    // 4) 融合
    const w = weights()
    const fused = []
    for (const [id, basicScore] of fulltext) {
      const item = items.get(id)
      if (item === undefined || !allow(item)) continue
      const semanticScore = semanticScores.get(id) ?? 0
      const graphScore = graphScores.get(id) ?? 0
      const final = w.fulltext * basicScore + w.semantic * semanticScore + w.graph * graphScore
      fused.push({
        item,
        score: clamp(final),
        breakdown: { fulltext: round(basicScore), semantic: round(semanticScore), graph: round(graphScore), final: round(final) },
      })
    }
    fused.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      const importance = (right.item.importance ?? 5) - (left.item.importance ?? 5)
      if (importance !== 0) return importance
      return String(right.item.updatedAt ?? '').localeCompare(String(left.item.updatedAt ?? ''))
    })

    const result = {
      items: fused.slice(0, limit),
      total: fused.length,
      tookMs: Date.now() - started,
      weights: w,
      cached: false,
    }
    cache.set(cacheKey, result)
    counters.searches += 1
    counters.totalMs += result.tookMs
    return result
  }

  return {
    rebuild(items) {
      index.rebuild(items)
      vectorCache.clear()
      bump()
    },
    upsert(item) {
      index.add(item)
      vectorCache.delete(item.id)
      bump()
    },
    remove(id) {
      index.remove(id)
      vectorCache.delete(id)
      bump()
    },
    similarity(left, right) {
      return jaccard(tokenize(ftsText(left)), tokenize(ftsText(right)))
    },
    graphNeighbors,
    search,
    stats() {
      return {
        ...counters,
        cacheSize: cache.size,
        cacheHitRate: counters.cacheHits + counters.cacheMisses === 0
          ? 0
          : round(counters.cacheHits / (counters.cacheHits + counters.cacheMisses)),
        avgSearchTimeMs: counters.searches === 0 ? 0 : round(counters.totalMs / counters.searches),
        invertedTokens: index.size,
        indexedDocs: index.docs,
      }
    },
    resetStats() {
      counters = { searches: 0, totalMs: 0, cacheHits: 0, cacheMisses: 0, indexQueries: 0, semanticQueries: 0, graphQueries: 0 }
    },
  }
}


