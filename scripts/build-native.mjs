/**
 * 构建原生计算核心（Rust）并放进插件包的 native/<platform>-<arch>/ 目录。
 *
 * 用法：
 *   node scripts/build-native.mjs          # 构建 + 复制 + 自检（需要 cargo）
 *   node scripts/build-native.mjs --check  # 只检查现有二进制能否跑通
 *
 * 产物：packages/memory-plugin/native/<platform>-<arch>/memory-core[.exe]
 * 插件在运行时找不到二进制会退回纯 JS 计算（功能不丢，只是慢一点）。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CRATE = join(ROOT, 'native', 'memory-core')
const PLATFORM = `${process.platform}-${normalizeArch(process.arch)}`
const BINARY_NAME = process.platform === 'win32' ? 'memory-core.exe' : 'memory-core'
const TARGET_DIR = join(ROOT, 'packages', 'memory-plugin', 'native', PLATFORM)
const TARGET = join(TARGET_DIR, BINARY_NAME)
const CHECK_ONLY = process.argv.includes('--check')

function normalizeArch(arch) {
  if (arch === 'x64') return 'x64'
  if (arch === 'arm64') return 'arm64'
  return arch
}

function run(command, args, cwd) {
  // 沙箱里子进程不能接管道，直接 inherit。
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`)
}

function ping(binary) {
  const result = spawnSync(binary, [], {
    input: `${JSON.stringify({ id: 1, cmd: 'ping' })}\n`,
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`二进制退出码 ${result.status}`)
  const line = String(result.stdout ?? '').trim().split('\n')[0]
  const parsed = JSON.parse(line)
  if (parsed.ok !== true) throw new Error(`ping 失败：${line}`)
  return parsed.result
}

function checksum(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

if (CHECK_ONLY) {
  if (!existsSync(TARGET)) {
    console.error(`✗ 没有找到 ${TARGET}，先运行 node scripts/build-native.mjs`)
    process.exit(1)
  }
  const info = ping(TARGET)
  console.log(`✓ ${PLATFORM} 原生核心可用：version=${info.version} protocol=${info.protocol}`)
  console.log(`  路径 ${TARGET}（${(statSync(TARGET).size / 1024).toFixed(0)} KB，sha256:${checksum(TARGET)}）`)
  process.exit(0)
}

console.log(`== 构建原生核心（${PLATFORM}）==`)
// 优先离线：依赖已在 cargo 缓存里时不该依赖网络；失败再退回在线。
let mode = 'offline'
try {
  run('cargo', ['build', '--release', '--offline'], CRATE)
} catch {
  console.log('离线构建失败，改用在线模式重试…')
  mode = 'online'
  run('cargo', ['build', '--release'], CRATE)
}
console.log(`  构建模式 ${mode}`)

const built = join(CRATE, 'target', 'release', BINARY_NAME)
if (!existsSync(built)) {
  console.error(`✗ 构建产物不存在：${built}`)
  process.exit(1)
}
mkdirSync(dirname(TARGET), { recursive: true })
copyFileSync(built, TARGET)

const info = ping(TARGET)
const size = statSync(TARGET).size
console.log(`\n✓ 原生核心已就绪`)
console.log(`  目标 ${TARGET}`)
console.log(`  大小 ${(size / 1024).toFixed(0)} KB  sha256:${checksum(TARGET)}`)
console.log(`  自检 version=${info.version} protocol=${info.protocol}`)
