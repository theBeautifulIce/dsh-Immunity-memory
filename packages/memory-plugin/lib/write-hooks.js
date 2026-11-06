/**
 * 写入 / 更新生命周期 Hook。
 *
 * 设计约束：
 * - 覆盖引擎层 createItem / updateItem，因此工具、HTTP API、设置页 UI、导入都走同一套。
 * - before 可以拒绝（返回 { allow: false, reason }）或改写（返回 { patch } / { input }）。
 * - 任何一个 hook 抛错都只记日志并继续，不能因为 Hook 故障阻断记忆写入。
 * - after 在持久化成功后执行，抛错同样只记日志，不回滚已经落库的写入。
 */

function normalizeName(name, index) {
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : `hook-${index + 1}`
}

export function createWriteHookRegistry({ log = () => {} } = {}) {
  const before = []
  const after = []
  let nextId = 1

  function add(list, handler, name) {
    if (typeof handler !== 'function') throw new TypeError('write hook 必须是函数')
    const id = nextId
    nextId += 1
    const entry = { id, name: normalizeName(name, id), handler }
    list.push(entry)
    return () => {
      const index = list.findIndex((candidate) => candidate.id === id)
      if (index >= 0) list.splice(index, 1)
    }
  }

  function onBeforeWrite(handler, name) {
    return add(before, handler, name)
  }

  function onAfterWrite(handler, name) {
    return add(after, handler, name)
  }

  async function runBefore(context) {
    let input = context.input
    for (const entry of [...before]) {
      try {
        const result = await entry.handler({ ...context, input })
        if (result === false || result?.allow === false) {
          return {
            allowed: false,
            reason: typeof result?.reason === 'string' && result.reason.trim() !== ''
              ? result.reason.trim()
              : `写入被 Hook「${entry.name}」拒绝`,
            input,
          }
        }
        if (result?.input !== undefined) {
          if (result.input === null || typeof result.input !== 'object' || Array.isArray(result.input)) {
            throw new TypeError('before hook 返回的 input 必须是对象')
          }
          input = result.input
        } else if (result?.patch !== undefined) {
          if (result.patch === null || typeof result.patch !== 'object' || Array.isArray(result.patch)) {
            throw new TypeError('before hook 返回的 patch 必须是对象')
          }
          input = { ...input, ...result.patch }
        }
      } catch (error) {
        log('warn', `写入 Hook「${entry.name}」执行失败，已放行：${error?.message ?? error}`)
      }
    }
    return { allowed: true, input }
  }

  async function runAfter(context) {
    for (const entry of [...after]) {
      try {
        await entry.handler(context)
      } catch (error) {
        log('warn', `写入后 Hook「${entry.name}」执行失败：${error?.message ?? error}`)
      }
    }
  }

  return {
    onBeforeWrite,
    onAfterWrite,
    runBefore,
    runAfter,
    list: () => ({
      before: before.map((entry) => ({ id: entry.id, name: entry.name })),
      after: after.map((entry) => ({ id: entry.id, name: entry.name })),
    }),
  }
}
