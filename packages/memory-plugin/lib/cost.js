/**
 * 回顾开销量化。
 *
 * 插件不冒领 token 统计：它只能看到自己写进提示词的那段文字，所以这里
 * 只估算「每次回顾让模型多读了多少字对应的 token」以及「这一次回顾换回
 * 了多少条记忆」。真实 token 以宿主账单为准，估算只用于相对比较与自适应。
 */
import { estimateTokens } from './text.js'

/** 一轮回顾的「成本 / 产出」：成本只算提醒块，产出按新建条目数。 */
export function reviewCost(run) {
  if (run === null || typeof run !== 'object') return null
  if (run.trigger !== 'small_review' && run.trigger !== 'large_review') return null
  const promptTokens = Number(run.promptTokens) || 0
  const created = Array.isArray(run.created) ? run.created.length : 0
  return {
    at: run.at,
    trigger: run.trigger,
    promptTokens,
    created,
    skipped: Array.isArray(run.skipped) ? run.skipped.length : 0,
    // 每 100 token 提醒换回多少条记忆；没有提醒文本时记 0，避免除零。
    per100Tokens: promptTokens > 0 ? Math.round((created / promptTokens) * 100 * 100) / 100 : 0,
  }
}

/**
 * 汇总回顾开销：只看小/大回顾，最多最近 20 次。
 * `backoff` 是当前的自适应倍数（1 = 没有拉长间隔）。
 */
export function reviewCostSummary(runs, backoff = 1) {
  const list = Array.isArray(runs) ? runs : []
  const reviews = list.map(reviewCost).filter((entry) => entry !== null).slice(-20)
  const totalTokens = reviews.reduce((sum, entry) => sum + entry.promptTokens, 0)
  const totalCreated = reviews.reduce((sum, entry) => sum + entry.created, 0)
  return {
    reviews: reviews.length,
    totalPromptTokens: totalTokens,
    totalCreated,
    avgPromptTokens: reviews.length === 0 ? 0 : Math.round(totalTokens / reviews.length),
    avgCreated: reviews.length === 0 ? 0 : Math.round((totalCreated / reviews.length) * 100) / 100,
    per100Tokens: totalTokens > 0 ? Math.round((totalCreated / totalTokens) * 100 * 100) / 100 : 0,
    backoff: Math.round((Number(backoff) || 1) * 10) / 10,
    recent: reviews.slice(-5),
  }
}

/**
 * 自适应倍数的下一步：连续回顾都写不出东西就拉长间隔，能写出来就往回收。
 * 上限 3 倍（避免一直不回顾），下限 1 倍。
 */
export function nextBackoff(current, produced) {
  const value = Number.isFinite(Number(current)) ? Number(current) : 1
  const base = Math.min(3, Math.max(1, value))
  const next = produced > 0 ? base - 0.5 : base + 0.5
  return Math.min(3, Math.max(1, Math.round(next * 10) / 10))
}

/** 提醒块本身的 token 估算，供 capture() 记录「这次回顾多读了多少」。 */
export function promptCost(text) {
  return estimateTokens(text)
}
