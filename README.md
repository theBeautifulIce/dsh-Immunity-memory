# 记忆插件（dsh-memory-plugin）

给 DeepSeek Harness（DSH）加一套**跨会话的长期记忆**：八层记忆体系 + 三本记事本 + 混合检索 + 自动维护，
并带一个**左侧栏「记忆」图标直接打开的整页界面**（设置页入口也保留）。

它不是「一个 JS 文件把数据塞进 JSON」：检索与持久化由独立的 Go 服务承担（SQLite + FTS5 + 图谱），
批量数学由 Rust 原生核心承担，Node 只做插件宿主该做的控制层。

## 架构

| 层 | 语言 / 产物 | 职责 |
| --- | --- | --- |
| 控制层 | Node.js（宿主进程） | 插件入口 `apply(ctx)`、6 个 agent 工具、系统提示词注入、界面 HTTP 接口、维护与备份的编排、原生组件缺失时的降级 |
| 服务层 | Go → `packages/memory-plugin/bin/win32-x64/memory-service.exe` | SQLite 持久化、FTS5（bm25）全文检索、向量余弦、关系图谱 BFS、审计/备份/完整性校验、优雅退出 |
| 计算核心 | Rust → `packages/memory-plugin/native/win32-x64/memory-core.exe` | 批量余弦、重要性评分、去重/相似度（JSON lines over stdio） |

为什么这样切：

- 插件宿主入口与浏览器端模块**必须是 JS**（cordis 契约），但计算与持久化层没有这个限制。
- Node 自带的 `node:sqlite` **没有 FTS5**（`no such module: fts5`），而 Go 的 `modernc.org/sqlite` 是纯 Go、免 cgo、FTS5 开箱可用。
- 设计文档里的 gRPC 用**回环 HTTP + JSON + 随机 token** 替代：Node 侧零额外依赖，插件安装不联网，跨平台没有 `.proto` 编译链。
- Go/Rust 二进制缺失或启动失败时自动退回 Node 内置实现（无 FTS5、检索能力降级），并在日志与设置页里明确标注，不静默降级。

## 快速开始

```pwsh
# 1. 构建原生组件（已提交二进制时可跳过）
node scripts/build-native.mjs      # Rust 核心（需要 rustc/cargo）
node scripts/build-go.mjs          # Go 服务（需要 go，默认在 PATH；本机是 D:\GO\bin）

# 2. 自检
node scripts/check.mjs

# 3. 安装到当前桌面 profile（在 DSH 里让 agent 执行）
#    plugin_manager action=install_bundle target=D:\aboutAI\记忆插件设计\packages\memory-plugin

# 4. 打开任意会话的「设置」，左侧多出「记忆」一页
```

记忆库：`%USERPROFILE%\.dsh\storages\dsh-memory-plugin\memory.sqlite3`（可用 `DSH_HOME` 或设置页「存储」
改目录与引擎）。表：`memories` / `events` / `assets` / `relationships` / `changelog` / `config` /
`schema_migrations` / `service_migrations`，外加检索用的 `items_fts`（FTS5）、`memory_vectors`、`items_meta`。
Go 服务二进制在启动时复制到 `<库目录>\service\win32-x64\` 再运行，避免安装目录（尤其是 `link:`
开发安装）被宿主沙箱或只读策略限制。

## 功能

| 能力 | 说明 |
| --- | --- |
| 八层记忆 | L0 灵魂层（不可变）、L1 思想核心、L2 思想流动（冲突检测）、L3 本能行为、L4 学习行为、L5 目标记忆、L6 轮转记忆（保鲜期）、L7 情境感知 |
| 三本记事本 | 记忆记事本、日常记事本、资产记事本 |
| 混合检索 | FTS5 bm25 全文 + 384 维哈希向量余弦 + 关系图谱 BFS，三路按权重融合（默认 0.4 / 0.4 / 0.2，自动归一化） |
| 写入保护 | 最小正文长度、去重（jaccard 阈值）、不可变层只读、L2 冲突检测 |
| 自动维护 | 资源上限 / 过期清理 / 轮转归档 / 去重 / 反思提升 / 审计压缩，按设置的间隔自动跑，也可手动触发 |
| 数据安全 | WAL + 版本化迁移、完整性校验、定时与手动备份、备份恢复、导出/导入 |
| 提示词注入 | 每轮把最相关的若干条记忆拼进系统提示词，可预览、可关闭 |
| 可视化界面 | 左侧栏「记忆」图标打开整页：列表 + 搜索 + 编辑器 + 全部设置项 + 维护 + 备份 + 审计（设置页入口保留） |

## 仓库结构

```
.
├─ docs/
│  ├─ design/            # 需求与设计文档（原始输入）
│  ├─ reference/         # 参考代码（Go / Rust / gRPC 方案）
│  ├─ 开发说明.md        # 架构、数据模型、检索、构建、测试、发布
│  └─ 性能报告.md        # 基准结果（node scripts/benchmark.mjs 生成）
├─ go-service/           # Go 服务：internal/{text,store,search,api} + cmd/memory-service
├─ native/memory-core/   # Rust 计算核心源码（cargo 工程）
├─ packages/memory-plugin/
│  ├─ index.js           # 宿主入口：工具 / 提示词 / 维护定时器 / 接口挂载 / 组件生命周期
│  ├─ client.js          # 客户端界面（侧边栏整页 + 设置页，无构建，React.createElement）
│  ├─ lib/
│  │  ├─ go-store.js     # Go 服务客户端：spawn、握手、增量同步、检索、备份、关闭
│  │  ├─ storage.js      # 存储选择：Go → Node SQLite → JSON
│  │  ├─ engine.js       # 记忆引擎：CRUD、检索路由、冲突、维护、导出（全部 async）
│  │  ├─ search.js       # Node 回退检索：倒排 BM25 + 余弦 + 图谱 + 融合
│  │  ├─ sqlite.js       # Node 回退存储：迁移、向量表、备份
│  │  ├─ native.js       # Rust 核心客户端（JSON lines，自动 JS 兜底）
│  │  ├─ text.js / embeddings.js / fallback-math.js
│  │  ├─ settings.js / api.js / tools.js
│  ├─ native/win32-x64/          # 打包进插件的 memory-core.exe
│  └─ bin/win32-x64/             # 打包进插件的 memory-service.exe
├─ scripts/
│  ├─ build-native.mjs / build-go.mjs / check.mjs / benchmark.mjs / inspect-db.mjs
└─ tests/                # engine / engine-go / tools / search / sqlite / native / go-service / api / 渲染
```

## 自检与基准

```pwsh
node scripts/check.mjs        # 全部测试（语法、引擎、工具、存储、检索、原生、Go、接口、渲染）
node tests/go-service.test.mjs
node scripts/benchmark.mjs --items 2000 --queries 100 --graph 50 --out docs/性能报告.md
node scripts/inspect-db.mjs   # 只读查看当前记忆库
```

本机 2000 条数据的参考数字（详见 `docs/性能报告.md`）：批量导入 ~1830 条/秒，单条写入 12.9ms，
混合检索 6.9ms（p95 9.4），图谱 BFS 0.58ms，Rust 批量余弦 ~23600 对/秒。

## 目录约定

- 设计文档进 `docs/`，代码进 `packages/` 与 `go-service/`，测试进 `tests/`，一次性脚本进 `scripts/`。
- 运行期数据**不**进仓库（见 `.gitignore`），永远写在 DSH 的 `storages/` 下。
- 提交信息用 `类型: 摘要`，例如 `feat: 客户端记忆列表`、`fix: TTL 条目不过期`、`docs: 补充接口表`。

## 许可

MIT
