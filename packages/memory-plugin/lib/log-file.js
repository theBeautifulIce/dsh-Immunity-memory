/**
 * 结构化日志：一行一个 JSON 对象，按大小轮转。
 *
 * 为什么不沿用 plugin.log 的纯文本行：真出问题时，先要按 level 或事件名过滤，
 * 文本行只能靠眼睛一行行看。这里写 <dir>/memory-YYYY-MM-DD.jsonl，每行形如
 * {"ts":"…","level":"warn","event":"log","text":"…"}；单个文件超过 maxBytes 就
 * 按当天序号滚成 memory-YYYY-MM-DD.1.jsonl、.2…，只保留最新 keep 份。
 *
 * 写日志永远不能影响主流程：目录建不出来、盘满了、被占用，都只是 write() 返回 false。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 默认上限：单文件 2MB，最多留 8 份（含当天的）。 */
export const LOG_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, keep: 8 })

const NAME_PATTERN = /^memory-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/

/**
 * 造一个文件日志器。
 * @param {object} options
 * @param {string} options.dir 日志目录（会按需创建）
 * @param {number} [options.maxBytes] 单文件字节上限
 * @param {number} [options.keep] 最多保留几份
 * @param {() => Date} [options.now] 取当前时间（测试可注入）
 */
export function createFileLogger({ dir, maxBytes = LOG_LIMITS.maxBytes, keep = LOG_LIMITS.keep, now = () => new Date() }) {
  let current = null

  const fileFor = (day) => join(dir, `memory-${day}.jsonl`)

  function open(day) {
    mkdirSync(dir, { recursive: true })
    const path = fileFor(day)
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      size = 0
    }
    return { path, size }
  }

  /**
   * 只留最新 keep 份；名字按日期与当天序号排，先删最旧的。
   * 轮转时当前文件刚被挪走、马上会重建，所以这里按 keep - 1 收敛：
   * 轮转文件 + 新建的当天文件，加起来才等于 keep。
   */
  function prune() {
    let names
    try {
      names = readdirSync(dir).filter((name) => NAME_PATTERN.test(name)).sort()
    } catch {
      return
    }
    while (names.length > Math.max(0, keep - 1)) {
      const name = names.shift()
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        // 删不掉就留着，下一轮再试
      }
    }
  }

  /** 当天文件写满：滚一个同一天的 .N 文件，然后从空文件继续。 */
  function rotate(day) {
    const base = fileFor(day).replace(/\.jsonl$/, '')
    let index = 1
    while (existsSync(`${base}.${index}.jsonl`)) index += 1
    renameSync(fileFor(day), `${base}.${index}.jsonl`)
    current = { path: fileFor(day), size: 0 }
    prune()
  }

  return {
    /** 当前正在写的文件；还没写过任何一行时是 undefined。 */
    path: () => current?.path,
    /**
     * 追加一行。
     * @returns {boolean} 写成功为 true，任何失败都是 false（不抛）。
     */
    write(level, event, fields = {}) {
      try {
        const ts = now().toISOString()
        const day = ts.slice(0, 10)
        const line = `${JSON.stringify({ ts, level, event, ...fields })}\n`
        const bytes = Buffer.byteLength(line)
        if (current === null || current.path !== fileFor(day)) current = open(day)
        // 已经写过内容才轮转：否则一条超大行会在空文件上反复滚。
        if (current.size > 0 && current.size + bytes > maxBytes) rotate(day)
        appendFileSync(current.path, line)
        current.size += bytes
        return true
      } catch {
        return false
      }
    },
  }
}
