/**
 * 本地向量化（语义索引的"无依赖"实现，对应设计文档 §5.3 的 VectorSearchInterface）。
 *
 * 不调外部 embedding 服务：用 2-gram/词哈希到固定维度再 L2 归一化，属于
 * "特征哈希"（hashing trick）。它抓的是词面相似度，不是真正的语义模型，但：
 *   - 零依赖、零网络、确定性（同一段文本永远同一向量）；
 *   - 与 Rust 批量余弦配合，能在几毫秒内对上千条候选重排；
 *   - 将来要换真正的 embedding 服务，只需替换 `embed()`，接口不变。
 */
import { hash32, tokenize } from './text.js'

export const DEFAULT_DIM = 384

/**
 * 文本 → Float32Array 单位向量。
 * 每个 token 落到一个槽位并带符号；重复出现的 token 会累加，长文本权重更高。
 */
export function embed(text, dim = DEFAULT_DIM) {
  const vector = new Float32Array(dim)
  const tokens = tokenize(text)
  if (tokens.size === 0) return vector
  for (const token of tokens) {
    const hash = hash32(token)
    const index = hash % dim
    const sign = (hash & 0x80000000) !== 0 ? -1 : 1
    vector[index] += sign
    // 二元组再加一次到另一个槽位，保留一点词序信息
    const second = hash32(`${token}#`) % dim
    vector[second] += sign * 0.5
  }
  let norm = 0
  for (let index = 0; index < dim; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let index = 0; index < dim; index += 1) vector[index] /= norm
  }
  return vector
}

/** Float32Array → Buffer（小端，存 SQLite BLOB）。 */
export function vectorToBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

/** Buffer → Float32Array（校验长度）。 */
export function bufferToVector(buffer, dim = DEFAULT_DIM) {
  if (!(buffer instanceof Uint8Array) || buffer.byteLength < dim * 4) return null
  const copy = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + dim * 4))
  return new Float32Array(copy.buffer)
}

/** 单条余弦（测试与兜底用）。 */
export function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return denominator === 0 ? 0 : dot / denominator
}

/**
 * 把多条向量拼成矩阵（count × dim 的 Float32Array），喂给原生核心批量计算。
 * `entries` 是 `[id, Float32Array]` 的数组。
 */
export function packMatrix(entries, dim = DEFAULT_DIM) {
  const matrix = new Float32Array(entries.length * dim)
  entries.forEach(([, vector], index) => {
    if (vector === null || vector === undefined) return
    matrix.set(vector.subarray(0, Math.min(dim, vector.length)), index * dim)
  })
  return matrix
}
