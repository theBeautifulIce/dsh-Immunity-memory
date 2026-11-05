/**
 * 一键自检：语法检查 + 三套测试。
 *
 * 运行：node scripts/check.mjs            （全部）
 *      node scripts/check.mjs --fast     （只跑语法与引擎测试）
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAST = process.argv.includes('--fast')
const failures = []

function run(title, args) {
  const started = Date.now()
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  const ms = Date.now() - started
  if (result.status === 0) {
    console.log(`\n✔ ${title}（${ms}ms）`)
    return true
  }
  console.error(`\n✘ ${title}（退出码 ${result.status}）`)
  failures.push(title)
  return false
}

function collectJs(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      out.push(...collectJs(full))
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      out.push(full)
    }
  }
  return out
}

console.log('== 语法检查 ==')
const files = [...collectJs(join(ROOT, 'packages')), ...collectJs(join(ROOT, 'tests')), ...collectJs(join(ROOT, 'scripts'))]
for (const file of files) {
  // 注意：沙箱里不能给子进程接管道（EPERM），所以直接 inherit 输出。
  const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`✘ ${relative(ROOT, file)}`)
    failures.push(`syntax:${relative(ROOT, file)}`)
  }
}
if (failures.length === 0) console.log(`✔ ${files.length} 个模块语法正常`)

console.log('\n== 引擎测试 ==')
run('引擎测试', ['tests/engine.test.mjs'])

run('工具测试', ['tests/tools.test.mjs'])

run('SQLite 存储测试', ['tests/sqlite.test.mjs'])

if (!FAST) {
  console.log('\n== 接口测试 ==')
  run('接口测试', ['tests/api.test.mjs'])

  console.log('\n== 界面渲染测试 ==')
  run('界面渲染测试', ['tests/client.render.mjs'])
}

console.log('')
if (failures.length > 0) {
  console.error(`失败：${failures.join('、')}`)
  process.exit(1)
}
console.log('全部通过 ✅')
