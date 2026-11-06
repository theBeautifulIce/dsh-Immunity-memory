/**
 * 自动记忆捕获的纯工具函数。
 *
 * 这里只做文本判断与记事本去重，不碰持久化；是否写入、写到哪一层、TTL 多长
 * 都由智能体在 memory_capture 里显式填写。触发信号只负责提醒，不替智能体做决定。
 */
import { jaccard, tokenize } from './text.js'

export const CAPTURE_TRIGGERS = [
  'user_correction',
  'user_remember',
  'user_unhappy',
  'user_happy',
  'self_correction',
  'small_review',
  'large_review',
  'manual',
]

export const CAPTURE_LABELS = {
  user_correction: { zh: '用户纠错', en: 'User correction' },
  user_remember: { zh: '用户要求记住', en: 'User asked to remember' },
  user_unhappy: { zh: '用户不满', en: 'User unhappy' },
  user_happy: { zh: '用户满意', en: 'User happy' },
  self_correction: { zh: '智能体自省', en: 'Self correction' },
  small_review: { zh: '小时回顾', en: 'Hourly review' },
  large_review: { zh: '每日回顾', en: 'Daily review' },
  manual: { zh: '手动捕获', en: 'Manual capture' },
}

const TRIGGER_PATTERNS = [
  {
    trigger: 'user_correction',
    reason: '纠正/否定',
    pattern: /(你|您|刚才|上面|这次|这样|说的|做的).{0,12}(错|不对|有问题|搞错|弄错|理解错|说错|漏了|说反)|不是这样|应该是|纠正|改正|重新来|又错|不对吧/i,
  },
  {
    trigger: 'user_remember',
    reason: '要求记住',
    pattern: /(记住|记下|别忘了|不要忘|帮我记|替我记|保存下来|留个记录|以后.{0,10}(要|不要|都))/i,
  },
  {
    trigger: 'user_unhappy',
    reason: '不满/失望',
    pattern: /(失望|生气|不满|太差|糟糕|无语|烦死|难受|怎么又|又错|不行|离谱|什么玩意)/i,
  },
  {
    trigger: 'user_happy',
    reason: '满意/感谢',
    pattern: /(谢谢|太好了|不错|满意|开心|喜欢|靠谱|厉害|好耶|棒|awesome|thanks|perfect|great)/i,
  },
]

const SELF_PATTERN = /(我(刚才|之前|上面)?(说错|搞错|理解错|错了|漏了)|抱歉.{0,12}(我|刚才)|修正一下|纠正一下|实际上应该|不应该这样|我重新来)/i

/** 从消息对象里取出纯文本；兼容字符串、内容块数组和嵌套 message。 */
export function messageText(value) {
  // session/event 的形状是 { type, data }：user/message 的 data 就是消息，
  // assistant/message 的 data.message 才是消息；旧调用也可能直接传消息。
  const message = value?.data?.message ?? value?.data ?? value?.message ?? value
  const content = message?.content ?? value?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
        if (typeof block?.text === 'string') return block.text
        return ''
      })
      .filter((part) => part !== '')
      .join('\n')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/** 用户消息的即时信号；同一条消息可以同时命中多个。 */
export function detectUserSignals(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return []
  const found = []
  for (const rule of TRIGGER_PATTERNS) {
    const match = rule.pattern.exec(source)
    if (match === null) continue
    found.push({
      trigger: rule.trigger,
      reason: rule.reason,
      excerpt: excerptAround(source, match.index, match[0].length),
    })
  }
  return found
}

/** 助手自省信号：模型自己发现答错、修正或道歉时提醒捕获。 */
export function detectAssistantSignals(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return []
  const match = SELF_PATTERN.exec(source)
  if (match === null) return []
  return [{
    trigger: 'self_correction',
    reason: '自省/修正',
    excerpt: excerptAround(source, match.index, match[0].length),
  }]
}

export function captureLabel(trigger, lang = 'zh') {
  return CAPTURE_LABELS[trigger]?.[lang] ?? trigger
}

/**
 * 记事本去重归一化：大小写、全半角、空白和标点都忽略，只比较实际内容。
 * 记忆层不走这个函数，仍使用引擎的语义相似度。
 */
export function normalizeNoteText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function noteSimilarity(left, right) {
  return jaccard(tokenize(normalizeNoteText(left)), tokenize(normalizeNoteText(right)))
}

/**
 * 在同 notebook 的笔记里找重复：先精确归一化匹配，再按 token Jaccard 兜底。
 * 只扫描笔记，不误伤记忆层。
 */
export function findNoteDuplicate(items, input, threshold = 0.92) {
  const target = normalizeNoteText(input?.content)
  if (target === '') return undefined
  const notebook = input?.notebook
  for (const item of items ?? []) {
    if (item.type !== 'note' || item.notebook !== notebook) continue
    if (item.status === 'archived' || item.supersededBy !== null && item.supersededBy !== undefined) continue
    const candidate = normalizeNoteText(item.content)
    if (candidate === target) return { item, score: 1, exact: true }
    const score = noteSimilarity(candidate, target)
    if (score >= threshold) return { item, score, exact: false }
  }
  return undefined
}

/** `HH:MM` → 当天分钟数；非法值回退 04:00。 */
export function parseClock(value, fallback = '04:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (match === null) return parseClock(fallback, '04:00')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return parseClock(fallback, '04:00')
  return { hour, minute, minutes: hour * 60 + minute }
}

/** 每日回顾是否到点：今天的目标时刻已过，且上次回顾在目标时刻之前。 */
export function isDailyDue(now, dailyAt, lastAt) {
  const clock = parseClock(dailyAt)
  const today = new Date(now)
  today.setHours(clock.hour, clock.minute, 0, 0)
  const last = Date.parse(lastAt ?? '')
  return now >= today.getTime() && (!Number.isFinite(last) || last < today.getTime())
}

export function excerptAround(text, index, length, span = 80) {
  const start = Math.max(0, index - span)
  const end = Math.min(text.length, index + length + span)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function clipText(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}
