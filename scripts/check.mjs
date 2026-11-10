/**
 * 一键自检：语法检查 + 三套测试。
 *
 * 运行：node scripts/check.mjs            （全部）
 *      node scripts/check.mjs --fast     （只跑语法与引擎测试）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAST = process.argv.includes('--fast')
const failures = []
const GO_BINARY = join(ROOT, 'packages', 'memory-plugin', 'bin', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, process.platform === 'win32' ? 'memory-service.exe' : 'memory-service')
const NATIVE_BINARY = join(ROOT, 'packages', 'memory-plugin', 'native', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, process.platform === 'win32' ? 'memory-core.exe' : 'memory-core')

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

run('索引模式测试', ['tests/index-mode.test.mjs'])

run('记事本渐进加载测试', ['tests/notes-index.test.mjs'])

run('审计测试', ['tests/audit.test.mjs'])

run('工具测试', ['tests/tools.test.mjs'])

run('检索测试', ['tests/search.test.mjs'])

run('召回重排测试', ['tests/recall.test.mjs'])

run('SQLite 存储测试', ['tests/sqlite.test.mjs'])

run('日志测试', ['tests/log-file.test.mjs'])

if (!FAST) {
  if (existsSync(NATIVE_BINARY)) {
    console.log('\n== 原生核心测试 ==')
    run('原生核心测试', ['tests/native.test.mjs'])
  } else {
    console.warn('\n⚠ 跳过原生核心测试（先运行 node scripts/build-native.mjs）')
  }

  if (existsSync(GO_BINARY)) {
    console.log('\n== Go 服务测试 ==')
    run('Go 服务测试', ['tests/go-service.test.mjs'])
    console.log('\n== 引擎 × Go 服务 ==')
    run('引擎×Go 测试', ['tests/engine-go.test.mjs'])
  } else {
    console.warn('\n⚠ 跳过 Go 服务测试（先运行 node scripts/build-go.mjs）')
  }

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
