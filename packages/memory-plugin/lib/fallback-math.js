/**
 * 纯 JS 的数学兜底实现。
 *
 * 原生核心（Rust）不可用时用它顶上，保证"功能全都在、只是慢一点"：
 *   - 批量余弦相似度
 *   - 批量重要性评分
 *   - LSH 候选对 + 精确 Jaccard 去重
 *
 * 公式与 native/memory-core/src/main.rs 保持一致，两者可以互相校验。
 */

/** 单条余弦相似度。 */
export function cosineOne(query, candidate, dim) {
  let dot = 0
  let queryNorm = 0
  let candidateNorm = 0
  for (let index = 0; index < dim; index += 1) {
    const left = query[index]
    const right = candidate[index]
    dot += left * right
    queryNorm += left * left
    candidateNorm += right * right
  }
  const denominator = Math.sqrt(queryNorm) * Math.sqrt(candidateNorm)
  return denominator === 0 ? 0 : dot / denominator
}

/** 批量余弦：matrix 是 count × dim 的扁平 Float32Array。 */
export function fallbackCosineBatch(query, matrix, count, dim) {
  const out = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    out[index] = cosineOne(query, matrix.subarray(index * dim, (index + 1) * dim), dim)
  }
  return out
}

/** 批量重要性：时间衰减 0.4 + 访问频次 0.4 + 关联度 0.2。 */
export function fallbackImportance(items, nowSeconds) {
  const out = new Float32Array(items.length)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] ?? {}
    const created = Number.isFinite(item.createdAt) ? item.createdAt : nowSeconds
    const lastAccess = Number.isFinite(item.lastAccessAt) ? item.lastAccessAt : created
    const ageDays = Math.max(0, nowSeconds - lastAccess) / 86400
    const createdDays = Math.max(0, nowSeconds - created) / 86400
    const decay = Math.exp(-ageDays / 30) * 0.7 + Math.exp(-createdDays / 90) * 0.3
    const frequency = Math.min(1, (item.accessCount ?? 0) / 10)
    const association = Math.min(1, (item.relatedCount ?? 0) / 20)
    out[index] = decay * 0.4 + frequency * 0.4 + association * 0.2
  }
  return out
}

/** token 数组 → Set，兼容已去重的输入。 */
function toSet(tokens) {
  return tokens instanceof Set ? tokens : new Set(Array.isArray(tokens) ? tokens : [])
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const token of small) if (large.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** 去重：先用共享 token 生成候选对，再算精确 Jaccard。 */
export function fallbackDedupe(items, threshold) {
  const sets = items.map((item) => toSet(item.tokens))
  const postings = new Map()
  for (let index = 0; index < sets.length; index += 1) {
    for (const token of sets[index]) {
      if (!postings.has(token)) postings.set(token, [])
      postings.get(token).push(index)
    }
  }
  const seen = new Set()
  const pairs = []
  for (const indices of postings.values()) {
    if (indices.length < 2 || indices.length > 200) continue
    for (let left = 0; left < indices.length; left += 1) {
      for (let right = left + 1; right < indices.length; right += 1) {
        const a = Math.min(indices[left], indices[right])
        const b = Math.max(indices[left], indices[right])
        const key = `${a}:${b}`
        if (seen.has(key)) continue
        seen.add(key)
        const score = jaccard(sets[a], sets[b])
        if (score >= threshold) pairs.push({ a: items[a]?.id, b: items[b]?.id, score })
      }
    }
  }
  return pairs
}

/** 相似度：查询 token 与候选集合逐个比。 */
export function fallbackSimilar(tokens, candidates) {
  const query = toSet(tokens)
  return candidates.map((candidate) => ({
    id: candidate.id,
    score: jaccard(query, toSet(candidate.tokens)),
  }))
}
