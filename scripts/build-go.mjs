/**
 * 构建 Go 服务并放进插件包的 bin/<platform>-<arch>/ 目录。
 *
 * 用法：
 *   node scripts/build-go.mjs          # 构建 + 自检
 *   node scripts/build-go.mjs --check  # 只检查现有二进制
 *
 * 产物：packages/memory-plugin/bin/<platform>-<arch>/memory-service[.exe]
 * 插件在运行时找不到 Go 服务时退回 Node 内置实现（功能不丢，性能降级）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SERVICE_DIR = join(ROOT, 'go-service')
const PLATFORM = `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
const BINARY_NAME = process.platform === 'win32' ? 'memory-service.exe' : 'memory-service'
const TARGET_DIR = join(ROOT, 'packages', 'memory-plugin', 'bin', PLATFORM)
const TARGET = join(TARGET_DIR, BINARY_NAME)
const CHECK_ONLY = process.argv.includes('--check')

function checksum(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`)
}

async function ping(binary) {
  const dir = join(ROOT, '.tmp', `build-check-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const child = spawn(binary, ['-db', join(dir, 'probe.sqlite3'), '-token', 'probe'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  try {
    const handshake = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('握手超时')), 10_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        const line = buffer.split('\n')[0]
        if (line.trim() === '') return
        clearTimeout(timer)
        try {
          resolve(JSON.parse(line))
        } catch (error) {
          reject(error)
        }
      })
      child.on('exit', (code) => reject(new Error(`服务提前退出（code ${code}）`)))
    })
    const response = await fetch(`http://127.0.0.1:${handshake.port}/health`)
    const health = await response.json()
    if (health.ok !== true) throw new Error(`health 返回异常：${JSON.stringify(health)}`)
    return { handshake, health }
  } finally {
    child.kill()
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', resolve)
      setTimeout(resolve, 2000)
    })
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上 SQLite 句柄释放可能滞后，临时目录留给系统清理
    }
  }
}

if (CHECK_ONLY) {
  if (!existsSync(TARGET)) {
    console.error(`✗ 没有找到 ${TARGET}，先运行 node scripts/build-go.mjs`)
    process.exit(1)
  }
  const { handshake, health } = await ping(TARGET)
  console.log(`✓ Go 服务可用：port=${handshake.port} version=${health.version}`)
  console.log(`  路径 ${TARGET}（${(statSync(TARGET).size / 1024 / 1024).toFixed(1)} MB，sha256:${checksum(TARGET)}）`)
  process.exit(0)
}

console.log(`== 构建 Go 服务（${PLATFORM}）==`)
const built = join(SERVICE_DIR, BINARY_NAME)
run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', built, './cmd/memory-service'], SERVICE_DIR)
mkdirSync(dirname(TARGET), { recursive: true })
copyFileSync(built, TARGET)

const { health } = await ping(TARGET)
const size = statSync(TARGET).size
console.log(`\n✓ Go 服务已就绪`)
console.log(`  目标 ${TARGET}`)
console.log(`  大小 ${(size / 1024 / 1024).toFixed(1)} MB  sha256:${checksum(TARGET)}`)
console.log(`  自检 version=${health.version} db=${health.db}`)


