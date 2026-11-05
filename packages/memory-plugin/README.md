# dsh-memory-plugin

DSH（DeepSeek Harness）长期记忆插件：八层记忆体系、三本记事本、混合检索（FTS5 + 向量 + 图谱）、
自动反思维护，外加一个装在「设置」里的可视化界面。

## 安装

在 DSH 中让 agent 执行：

```
plugin_manager action=install_bundle target=<本包绝对路径>
```

安装后新开一个会话即可生效（替换已安装版本需要重启 DSH）。包内已带
`bin/win32-x64/memory-service.exe`（Go 服务）与 `native/win32-x64/memory-core.exe`（Rust 核心），
普通安装不需要构建链。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主入口：注册 6 个工具、系统提示词段落、定时维护/自动备份、挂载 HTTP 接口、管理原生组件 |
| `client.js` | 客户端界面：侧边栏 `memory` 整页 + `settings.section` 入口 |
| `lib/go-store.js` | Go 服务客户端：spawn、握手、增量同步、检索、备份、关闭 |
| `lib/storage.js` | 存储选择：Go 服务 → Node SQLite → JSON |
| `lib/engine.js` | 记忆引擎：条目 CRUD、检索路由、冲突检测、维护任务、导出导入（全 async） |
| `lib/search.js` | Node 回退检索：倒排 BM25 + 余弦 + 图谱 + 融合 |
| `lib/sqlite.js` | Node 回退存储：迁移、向量表、备份 |
| `lib/native.js` | Rust 核心客户端（JSON lines over stdio，自动 JS 兜底） |
| `lib/settings.js` | 设置结构（schema）、八层与三本记事本定义、归一化与补丁合并 |
| `lib/api.js` | 设置页调用的 HTTP 接口（前缀 `/dsh-memory-plugin/api/v2`） |
| `lib/tools.js` | agent 工具注册 |
| `locale/*.json` | 插件列表里的标题与描述 |

## 数据

默认写入 **SQLite**：`%USERPROFILE%\.dsh\storages\dsh-memory-plugin\memory.sqlite3`
（可用 `DSH_HOME` 覆盖，也可在设置页「存储」分组里改目录/引擎）。库由 Go 服务持有：
WAL、版本化迁移、`memories` / `events` / `assets` / `relationships` / `changelog` / `config` /
`schema_migrations`，以及检索用的 `items_fts`（FTS5）、`memory_vectors`、`items_meta`。
备份在库同目录的 `backups/`，保留最近 10 份。

设置 `storage.engine = sqlite` 时退回宿主内置 `node:sqlite`（无 FTS5，检索降级），
`storage.engine = json` 时用单文件 `store.json`（临时文件 + rename，保留 `.bak-N`）。
Go 服务二进制缺失或启动失败时，`auto` 会自动回退并在日志/设置页标注。

## 设置项

设置页按「通用 / 存储 / 检索 / 写入 / 分层开关 / 提示词注入 / 维护 / 性能 / 隐私 / 模型工具」
分组，可改完即存、可一键恢复默认。其中：

- `layers.*`：逐层开关，关掉后该层不再被读写
- `retrieval.*`：语义/图谱开关、三路融合权重、图谱深度与种子数、缓存大小
- `prompt.*`：是否注入系统提示词、每次注入几条、字数上限
- `maintenance.*`：自动维护间隔、保鲜期、归档天数、轮转阈值、资源上限、反思提升阈值、冲突阈值
- `storage.*`：引擎、目录、备份保留数、自动备份间隔
- `performance.nativeCore`：是否启用 Rust 原生核心
- `tools.enabled`：是否向模型暴露记忆工具

## 许可

MIT
