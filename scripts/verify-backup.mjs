#!/usr/bin/env node
/**
 * 备份校验：把 backups/ 里的备份真的打开一遍，看能不能读、完整性如何。
 *
 * 默认只验最新一份，`--all` 验全部。退出码 0 表示全部通过，1 表示有不通过的。
 *
 * 用法：
 *   node scripts/verify-backup.mjs
 *   node scripts/verify-backup.mjs --all
 *   node scripts/verify-backup.mjs "D:\some\backups"
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { verifyBackupFile } from '../packages/memory-plugin/lib/backup-verify.js'

const args = process.argv.slice(2)
const all = args.includes('--all')
const dirArg = args.find((arg) => !arg.startsWith('--'))
const dir = dirArg ?? join(homedir(), '.dsh', 'storages', 'dsh-memory-plugin', 'backups')

if (!existsSync(dir)) {
  console.error(`备份目录不存在：${dir}`)
  process.exit(1)
}

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sqlite3'))
  .map((name) => {
    const path = join(dir, name)
    return { name, path, mtime: statSync(path).mtimeMs }
  })
  .sort((left, right) => right.mtime - left.mtime)

if (files.length === 0) {
  console.error(`没有可校验的备份：${dir}`)
  process.exit(1)
}

let failed = 0
for (const file of all ? files : files.slice(0, 1)) {
  const report = verifyBackupFile(file.path)
  const when = new Date(file.mtime).toISOString().replace('T', ' ').slice(0, 19)
  const size = (report.bytes / 1024 / 1024).toFixed(2)
  console.log(
    `${report.ok ? 'ok  ' : 'FAIL'} ${file.name}  ${when}  ${size} MB  ` +
      `integrity=${report.integrity}  items=${report.items}  edges=${report.edges}`,
  )
  if (!report.ok) failed += 1
}

process.exit(failed === 0 ? 0 : 1)
