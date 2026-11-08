/**
 * 文本工具：分词、相似度、哈希。
 *
 * 单独抽出来是因为现在有三处要用：
 *   - engine.js  打分与去重
 *   - sqlite.js  维护 FTS5 的 search_text 列
 *   - embeddings.js 生成哈希向量
 * 都是纯函数，没有状态。
 */

const LATIN = /[a-z0-9][a-z0-9_+#.-]{1,}/g
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g

/**
 * 分词：英文按词，中文按单字 + 二元组。
 * 返回 Set（去重）；需要数组时用 `tokenList`。
 */
export function tokenize(text) {
  const tokens = new Set()
  const source = String(text ?? '').toLowerCase()
  if (source === '') return tokens
  let match
  LATIN.lastIndex = 0
  while ((match = LATIN.exec(source)) !== null) tokens.add(match[0])
  const runs = source.match(CJK_RUN) ?? []
  for (const run of runs) {
    for (let index = 0; index < run.length; index += 1) {
      tokens.add(run[index])
      if (index + 1 < run.length) tokens.add(run.slice(index, index + 2))
    }
  }
  return tokens
}

/** 分词结果转数组（稳定顺序，便于哈希和 FTS 文本）。 */
export function tokenList(text) {
  return [...tokenize(text)]
}

/**
 * 估算文本的 token 数。
 *
 * 这里不引入 tokenizer 依赖：记忆注入是「预算控制」而不是计费，按经验口径
 * 中文/全角字符约 1 token，其它字符约 4 字符 1 token 已经足够接近主流模型，
 * 且跨模型稳定、零依赖。UI 与用量账本都用同一口径，保证前后一致。
 */
export function estimateTokens(text) {
  const source = String(text ?? '')
  if (source === '') return 0
  let wide = 0
  let narrow = 0
  for (const char of source) {
    const code = char.codePointAt(0)
    // CJK、全角标点、假名、韩文等按单 token；其余按 4 字符 1 token。
    if (
      (code >= 0x1100 && code <= 0x11ff)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xffef)
    ) wide += 1
    else narrow += 1
  }
  return Math.max(1, Math.ceil(wide + narrow / 4))
}

/** 一条记忆可检索的文本：标题 + 正文 + 标签 + 「能回答什么问题」。 */
export function searchableText(item) {
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ') : ''
  const questions = Array.isArray(item?.questions) ? item.questions.join(' ') : ''
  return `${item?.title ?? ''} ${item?.content ?? ''} ${tags} ${questions}`
}

/** FTS5 用的 search_text：把分词结果用空格拼起来（中文已切成二元组）。 */
export function ftsText(item) {
  return tokenList(searchableText(item)).join(' ')
}

/** Jaccard 相似度（两个 token 集合）。 */
export function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const token of small) if (large.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** 32 位 FNV-1a：给哈希向量和分桶用，要求跨进程稳定。 */
export function hash32(text) {
  let hash = 0x811c9dc5
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * 由分词结果生成固定的稀疏签名（MinHash 风格）：
 * 取 token 哈希排序后的前 k 个，用于快速候选筛选（LSH 的简化版）。
 */
export function sketch(tokens, size = 16) {
  const hashes = []
  for (const token of tokens) hashes.push(hash32(token))
  hashes.sort((left, right) => left - right)
  const out = []
  let previous = -1
  for (const hash of hashes) {
    if (hash === previous) continue
    previous = hash
    out.push(hash)
    if (out.length >= size) break
  }
  return out
}

/**
 * 带词频的分词：返回 token → 出现次数。
 * 倒排索引用它算 BM25 的 tf（tokenize 返回的是去重集合，适合哈希向量）。
 */
export function tokenCounts(text) {
  const counts = new Map()
  const source = String(text ?? '').toLowerCase()
  if (source === '') return counts
  const bump = (token) => counts.set(token, (counts.get(token) ?? 0) + 1)
  let match
  LATIN.lastIndex = 0
  while ((match = LATIN.exec(source)) !== null) bump(match[0])
  const runs = source.match(CJK_RUN) ?? []
  for (const run of runs) {
    for (let index = 0; index < run.length; index += 1) {
      bump(run[index])
      if (index + 1 < run.length) bump(run.slice(index, index + 2))
    }
  }
  return counts
}
