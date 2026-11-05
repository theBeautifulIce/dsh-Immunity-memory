/**
 * 查看记忆库（默认读 <DSH_HOME>/storages/dsh-memory-plugin/memory.sqlite3）。
 *
 * 用法：
 *   node scripts/inspect-db.mjs                 # 默认位置，只读
 *   node scripts/inspect-db.mjs <库路径>        # 指定库
 *   node scripts/inspect-db.mjs <库路径> --rows # 额外打印记忆标题
 *
 * 只读打开，不会改动数据；WAL 模式下也能安全读取。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const arg = process.argv.slice(2).find((value) => !value.startsWith('--'))
const showRows = process.argv.includes('--rows')
const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const path = arg ?? join(home, 'storages', 'dsh-memory-plugin', 'memory.sqlite3')

if (!existsSync(path)) {
  console.error(`数据库不存在：${path}`)
  process.exit(1)
}

const db = new DatabaseSync(path, { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name)
console.log(`数据库：${path}`)
console.log(`表：${tables.join(', ')}\n`)

const counts = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM memories) AS memories,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM assets) AS assets,
    (SELECT COUNT(*) FROM relationships) AS relationships,
    (SELECT COUNT(*) FROM changelog) AS changelog
`).get()
console.log('行数：', JSON.stringify(counts))

const layers = db.prepare('SELECT layer, COUNT(*) AS n FROM memories GROUP BY layer ORDER BY layer').all()
console.log('分层分布：', layers.map((row) => `${row.layer}=${row.n}`).join(', ') || '空')

const importance = db.prepare('SELECT ROUND(AVG(importance_score) * 10, 1) AS avg FROM memories').get()
console.log('平均重要度（1-10）：', importance.avg ?? 0)

const config = db.prepare('SELECT key, updated_at FROM config ORDER BY key').all()
console.log('config：', config.map((row) => `${row.key}(${row.updated_at})`).join(', ') || '空')

if (showRows) {
  console.log('\n记忆：')
  for (const row of db.prepare('SELECT id, layer, type, title, status, importance_score FROM memories ORDER BY updated_at DESC LIMIT 20').all()) {
    console.log(`  ${row.id}  ${row.layer}  ${row.type}  ${row.title}  [${row.status}]  重要度 ${Math.round(row.importance_score * 10)}`)
  }
  console.log('\n记事（events）：')
  for (const row of db.prepare('SELECT id, event_type, title FROM events ORDER BY timestamp DESC LIMIT 20').all()) {
    console.log(`  ${row.id}  ${row.event_type}  ${row.title}`)
  }
}

db.close()
