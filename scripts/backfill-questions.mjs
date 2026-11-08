/**
 * 给库里已有的条目补「能回答什么问题」（questions），不碰正文、不碰时间戳。
 *
 * 用法：
 *   node scripts/backfill-questions.mjs <map.json> --dry   # 只打印将要写入的内容
 *   node scripts/backfill-questions.mjs <map.json> --apply # 真正写库（先做一份一致性备份）
 *
 * map.json 形如 { "mem_xxx": ["他会怎么问1", "他会怎么问2"] }。
 * 只改 metadata 里的 questions：不写 changelog、不改 updated_at，避免影响新近度排序。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh')
const DB = process.env.MEMORY_DB || join(HOME, 'storages', 'dsh-memory-plugin', 'memory.sqlite3')
const mapPath = process.argv.slice(2).find((value) => !value.startsWith('--'))
const apply = process.argv.includes('--apply')

if (!mapPath) {
  console.error('用法：node scripts/backfill-questions.mjs <map.json> [--apply]')
  process.exit(1)
}
if (!existsSync(DB)) {
  console.error(`数据库不存在：${DB}`)
  process.exit(1)
}

const map = JSON.parse(await (await import('node:fs/promises')).readFile(mapPath, 'utf8'))
const db = new DatabaseSync(DB)
db.exec('PRAGMA busy_timeout = 5000')

const rows = db.prepare('SELECT id, layer, title, metadata FROM memories').all()
const byId = new Map(rows.map((row) => [row.id, row]))

const planned = []
for (const [id, questions] of Object.entries(map)) {
  const row = byId.get(id)
  if (row === undefined) {
    planned.push({ id, skip: '库里没有这条' })
    continue
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    planned.push({ id, skip: 'questions 为空' })
    continue
  }
  const metadata = JSON.parse(row.metadata || '{}')
  const before = Array.isArray(metadata.questions) ? metadata.questions : []
  planned.push({ id, layer: row.layer, title: row.title, before, after: questions.slice(0, 4) })
}

for (const entry of planned) {
  if (entry.skip !== undefined) {
    console.log(`  skip ${entry.id}：${entry.skip}`)
    continue
  }
  console.log(`  ${entry.layer} ${entry.id}  ${entry.title}`)
  console.log(`      旧：${entry.before.length === 0 ? '（空）' : entry.before.join(' / ')}`)
  console.log(`      新：${entry.after.join(' / ')}`)
}

const write = planned.filter((entry) => entry.skip === undefined)
const untouched = rows.filter((row) => map[row.id] === undefined)
if (untouched.length > 0) {
  console.log(`\n没有写法的条目 ${untouched.length} 条（保持原样）：`)
  for (const row of untouched) console.log(`  ${row.layer} ${row.id}  ${row.title}`)
}

if (!apply) {
  console.log(`\n干跑：将更新 ${write.length} 条。加 --apply 真正写入。`)
  process.exit(0)
}

const backupDir = join(dirname(DB), 'backups')
mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = join(backupDir, `backup_${stamp}_questions.sqlite3`)
db.exec('PRAGMA wal_checkpoint(FULL)')
copyFileSync(DB, backupPath)
console.log(`\n已备份：${backupPath}`)

const update = db.prepare('UPDATE memories SET metadata = ? WHERE id = ?')
let done = 0
for (const entry of write) {
  const row = byId.get(entry.id)
  const metadata = JSON.parse(row.metadata || '{}')
  metadata.questions = entry.after
  update.run(JSON.stringify(metadata), entry.id)
  done += 1
}
db.close()
console.log(`已写入 ${done} 条。`)
