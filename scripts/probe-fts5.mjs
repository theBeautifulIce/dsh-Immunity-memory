import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(':memory:')
try {
  db.exec('CREATE VIRTUAL TABLE t USING fts5(a, b)')
  console.log('fts5 create OK')
} catch (error) {
  console.log('fts5 create FAIL:', error.message)
}
try {
  db.exec('CREATE VIRTUAL TABLE t2 USING fts5(a)')
  db.exec("INSERT INTO t2 VALUES ('hello world')")
  console.log('fts5 insert OK', db.prepare('SELECT count(*) AS n FROM t2').get())
} catch (error) {
  console.log('fts5 insert FAIL:', error.message)
}
