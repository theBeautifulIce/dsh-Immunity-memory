/**
 * 备份校验：把一份备份复制到临时目录、打开它并跑一遍完整性检查。
 *
 * 为什么不在原地打开：备份文件可能正被其他进程持有（Windows 上尤其明显），
 * 而且校验过程会写 `-wal` / `-shm`；复制到临时目录再打开，才能保证校验本身
 * 不会碰到生产数据。临时目录在结束时整体删除。
 *
 * 只认 SQLite 快照（`backup_*_*.sqlite3`）。JSON 存储没有对应的备份列表，
 * 调用方拿到空列表时应给出明确提示，而不是伪造一份「校验通过」。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 从错误对象里取一段可读文本（不依赖 store.js，避免循环 import）。 */
function reason(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * 校验一份 SQLite 备份。
 *
 * @param {string} backupPath 备份文件路径。
 * @returns {{ ok: boolean, path: string, integrity: string, items: number,
 *   edges: number, bytes: number }} 校验结果；`ok` 只在 `PRAGMA integrity_check`
 *   返回 `ok` 时为真。打不开或结构不对时 `ok` 为假，原因写在 `integrity` 里。
 */
export function verifyBackupFile(backupPath) {
  if (!existsSync(backupPath)) throw new Error(`备份不存在：${backupPath}`)
  const bytes = statSync(backupPath).size
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-memory-verify-'))
  const copy = join(workdir, 'snapshot.sqlite3')
  try {
    copyFileSync(backupPath, copy)
    const database = new DatabaseSync(copy, { readOnly: true })
    try {
      const integrity = String(
        database.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown',
      )
      const items = Number(database.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n ?? 0)
      const edges = Number(
        database.prepare('SELECT COUNT(*) AS n FROM relationships').get()?.n ?? 0,
      )
      return { ok: integrity === 'ok', path: backupPath, integrity, items, edges, bytes }
    } finally {
      database.close()
    }
  } catch (error) {
    return { ok: false, path: backupPath, integrity: reason(error), items: 0, edges: 0, bytes }
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}
