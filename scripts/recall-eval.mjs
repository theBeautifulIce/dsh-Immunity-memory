/**
 * 召回评测：把一批「考点」灌进临时库，再看每道题的答案有没有被排到前面。
 *
 * 运行：node scripts/recall-eval.mjs
 * 只在 mkdtemp 沙箱里建库，跑完删掉；不碰线上 memory.sqlite3。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../packages/memory-plugin/lib/store.js'
import { createEngine } from '../packages/memory-plugin/lib/engine.js'
import { normalizeSettings } from '../packages/memory-plugin/lib/settings.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-memory-eval-'))
const liveSettings = normalizeSettings({
  prompt: { overrideBudget: true, topN: 30, maxChars: 6000 },
})
const store = createStore({ get: () => (name) => join(sandbox, name) }, () => {}, () => liveSettings)
const engine = await createEngine({ store, initialSettings: liveSettings, getSettings: () => liveSettings, log: () => {} })

const seeds = [
  { key: 'who', layer: 'L1', title: '啸春的称呼与身份', content: '用户名叫啸春，QQ 871170225，平时就直接叫「啸春」。', importance: 10, tags: ['身份'] },
  { key: 'birthday', layer: 'L4', title: '生日', content: '啸春的生日是 11 月 23 日。', importance: 7, tags: ['生日'] },
  { key: 'coffee', layer: 'L5', title: '喝咖啡的习惯', content: '喜欢冰美式、不加糖，一天最多两杯。', importance: 6, tags: ['喜好', '咖啡'] },
  { key: 'game', layer: 'L5', title: '打游戏时别连发消息', content: '晚上打游戏时不要连续追问，等他打完自己回。', importance: 8, tags: ['分寸', '游戏'] },
  { key: 'gpu', layer: 'L4', title: '显卡型号纠正', content: '他的显卡是 4080，不是 4090；此前被记错过一次，以下这条为准。', importance: 7, tags: ['硬件'] },
  { key: 'backup-plan', layer: 'L6', title: '备份整理计划', content: '计划 11-09 上午整理 dsh 的备份目录，目前还没开始。', importance: 5, tags: ['计划'] },
  { key: 'v043', layer: 'L4', title: 'v0.4.3 发布内容', content: 'v0.4.3 把待写入正文带进拒绝文案，并让不可变层只对智能体只读。', importance: 6, tags: ['发版'] },
  { key: 'v044', layer: 'L4', title: 'v0.4.4 发布内容', content: 'v0.4.4 让提示词注入按当轮上下文召回重排，命中条目加「·命中」标记。', importance: 6, tags: ['发版'] },
  { key: 'pwsh', layer: 'L4', title: 'pwsh 报错时的处置', content: 'pwsh 报 PTY shell exited during startup 时不要反复重试，请啸春在 QQ 窗口发 /permission f。', importance: 9, tags: ['工具', 'pwsh'] },
  { key: 'ccsn', layer: 'L5', title: '不装 cc-safety-net', content: '决定不装 cc-safety-net：官方把 Windows 桌面端安装路径标成 untested，风险不划算。', importance: 8, tags: ['插件', '决策'] },
  { key: 'dbpath', layer: 'L4', title: '记忆库文件位置', content: '线上记忆库在 C:\\Users\\ASUS\\.dsh\\storages\\dsh-memory-plugin\\memory.sqlite3。', importance: 6, tags: ['路径'] },
  { key: 'gitpush', layer: 'L4', title: 'git push 挂死的绕法', content: 'pwsh 里直接 git push 会被 GCM 弹窗挂死到 300 秒；要用 CredRead 取 token 再加 extraHeader 推。', importance: 7, tags: ['git'] },
  { key: 'nas', layer: 'L4', title: 'NAS 密码不外泄', content: '家里 NAS 的密码只在本地使用，不要写进任何外发内容或仓库。', importance: 8, tags: ['隐私'] },
  { key: 'wallet-a', layer: 'L4', title: '钱包余额（说法一）', content: '一次记录里说钱包余额是 120 元。', importance: 4, tags: ['冲突'] },
  { key: 'wallet-b', layer: 'L4', title: '钱包余额（说法二）', content: '另一次记录里说钱包余额是 300 元。', importance: 4, tags: ['冲突'] },
  { key: 'bili', layer: 'L5', title: 'B 站插件只自己用', content: 'dsh-bilibili 不提 PR 到官方市场，只自己用。', importance: 7, tags: ['插件'] },
  { key: 'phone', layer: 'L4', title: '旧手机号已停用', content: '旧手机号 13800000000 已经停用，联系请用现在这个。', importance: 5, tags: ['联系'] },
  { key: 'water', layer: 'L5', title: '容易忘记喝水', content: '啸春容易一坐半天忘记喝水，看到长会话可以顺口提醒一句。', importance: 6, tags: ['关心'] },
  { key: 'release', layer: 'L4', title: '发版流程', content: '发版流程：逐个文件跑 tests、更新 CHANGELOG 与版本号、commit、push、再打 tag。', importance: 7, tags: ['流程'] },
  { key: 'restart', layer: 'L4', title: '改完要重启桌面端', content: 'profile 是 link 直连源码，改完插件代码必须重启桌面端才生效。', importance: 8, tags: ['桌面端'] },
  { key: 'wake', layer: 'L4', title: '唤醒投递靠会话绑定', content: '主动唤醒靠会话绑定投递；每次新 QQ 回合要核对 chat-sessions.json 与计划任务 target 是否一致。', importance: 9, tags: ['唤醒'] },
]

const byKey = new Map()
for (const seed of seeds) {
  const mutable = ['L2', 'L4', 'L5', 'L6', 'L7'].includes(seed.layer)
  const item = await engine.createItem({
    layer: seed.layer,
    type: 'memory',
    title: seed.title,
    content: seed.content,
    importance: seed.importance,
    tags: seed.tags,
    ...(mutable ? { ttlDays: seed.ttlDays ?? 180 } : {}),
  }, 'user')
  byKey.set(seed.key, item.id)
}

const questions = [
  { q: 'pwsh 又报 PTY shell exited during startup 了，怎么办？', expect: ['pwsh'] },
  { q: '上次发的 v0.4.4 改了什么？', expect: ['v044'] },
  { q: 'v0.4.3 那次修的是哪块？', expect: ['v043'] },
  { q: '我记不清记忆库文件放哪了', expect: ['dbpath'] },
  { q: 'cc-safety-net 最后决定装还是不装？', expect: ['ccsn'] },
  { q: '我生日是哪天来着', expect: ['birthday'] },
  { q: '我显卡是 4090 对吧？', expect: ['gpu'] },
  { q: '明天上午我要干什么来着？', expect: ['backup-plan'] },
  { q: 'git push 又卡住了，怎么绕过', expect: ['gitpush'] },
  { q: 'B 站插件要不要给官方提 PR？', expect: ['bili'] },
  { q: '晚上我打游戏的时候你会一直催我吗', expect: ['game'] },
  { q: '我平时喝什么咖啡', expect: ['coffee'] },
  { q: '我叫什么名字', expect: ['who'] },
  { q: '我旧手机号是多少', expect: ['phone'] },
  { q: '发新版本之前要按什么流程走', expect: ['release'] },
  { q: '插件代码改完要不要重启桌面端', expect: ['restart'] },
  { q: '唤醒的话会不会掉地上', expect: ['wake'] },
  { q: 'NAS 密码能发到群里吗', expect: ['nas'] },
  { q: '我钱包里还有多少钱', expect: ['wallet-a', 'wallet-b'] },
  { q: '你会提醒我喝水吗', expect: ['water'] },
]

const negatives = ['今天上海天气怎么样', '帮我把这段 JSON 格式化一下', '这首诗押韵吗']

const isHit = (line, bar) => (line.relevance ?? 0) >= bar && (line.matched ?? 0) >= 2
// hitBar 为 null 表示「这一轮不标命中」，不能当成缺省值回退到 0.12。
const barOf = (digest) => (typeof digest.query?.hitBar === 'number' ? digest.query.hitBar : Infinity)

function rankOf(digest, ids) {
  const bar = barOf(digest)
  const memories = digest.lines.filter((line) => line.source === 'memory')
  let best = Infinity
  let hit = false
  for (let index = 0; index < memories.length; index += 1) {
    if (!ids.includes(memories[index].id)) continue
    if (index < best) best = index
    if (isHit(memories[index], bar)) hit = true
  }
  return { rank: best, hit, total: memories.length, bar }
}

const results = []
for (const [index, question] of questions.entries()) {
  engine.noteTurnContext({ sessionId: `eval-${index}`, kind: 'user', text: question.q })
  const digest = engine.injectionStats()
  const ids = question.expect.map((key) => byKey.get(key))
  const { rank, hit, total } = rankOf(digest, ids)
  results.push({ ...question, rank, hit, total, tokens: digest.query?.tokens ?? 0 })
}

const at = (n) => results.filter((result) => result.rank < n).length
const marked = results.filter((result) => result.hit).length
const negativeHits = []
for (const [index, text] of negatives.entries()) {
  engine.noteTurnContext({ sessionId: `neg-${index}`, kind: 'user', text })
  const digest = engine.injectionStats()
  const hits = digest.lines.filter((line) => line.source === 'memory' && isHit(line, barOf(digest)))
  const top = digest.lines.filter((line) => line.source === 'memory').slice(0, 3).map((line) => `${(line.relevance ?? 0).toFixed(3)}/${line.matched ?? 0}`)
  negativeHits.push({ text, hits: hits.length, top: top.join(','), tokens: digest.query?.tokens ?? 0 })
  if (process.env.DEBUG_RECALL) console.log('DBG', text, 'hitBar=', digest.query?.hitBar, 'lines=', digest.lines.filter((l) => l.source === 'memory').slice(0, 4).map((l) => `${l.title}:${l.relevance}/${l.matched}`).join(' | '))
}

console.log(`题目 ${results.length} 道，候选条目 ${results[0]?.total ?? 0} 条\n`)
for (const result of results) {
  const where = result.rank === Infinity ? '未进榜' : `第 ${result.rank + 1} 位`
  console.log(`${result.rank === 0 ? '✓' : '·'} ${result.q} → ${where}${result.hit ? '（标了命中）' : ''}`)
}
console.log(`\n命中率：@1 ${at(1)}/${results.length}  @3 ${at(3)}/${results.length}  @5 ${at(5)}/${results.length}  带命中标记 ${marked}/${results.length}`)
console.log(`反例（无关提问不该标命中）：${negativeHits.map((item) => `${item.text}：命中 ${item.hits} 条，前三条 relevance ${item.top}，查询词 ${item.tokens} 个`).join('  |  ')}`)

rmSync(sandbox, { recursive: true, force: true })
