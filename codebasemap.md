# codebasemap：记忆插件设计（dsh-Immunity-memory）

> 本文件说明「图谱存在哪、更新到哪、怎么更新」。
> 与 `handoff.md` 同放在仓库根目录。
> 生成时间：2026-11-10 10:40（首次建立）
> 最近更新：2026-11-10 15:20（渐进式加载改动后重刷：1210→1217 节点 / 3254→3276 边；新增 memory_notes 工具与 notesIndex 引擎接口）

## 图谱基本信息

| 项 | 值 |
|---|---|
| 图谱项目名 | `dsh-memory-plugin` |
| 仓库根路径 | `D:\aboutAI\记忆插件设计` |
| 索引器 | codebase-memory-mcp（stdio：`C:\Users\ASUS\AppData\Roaming\npm\node_modules\codebase-memory-mcp\bin\codebase-memory-mcp.exe`） |
| 节点数 / 边数 | 1217 / 3276 |
| 最近更新 | 2026-11-10 15:20（mode=fast 更新，原 1195/3239 → 再前 1008/2683） |
| 持久化产物 | **无**。中文路径下 `persistence=true` 会让索引 worker 崩溃（见下「坑」） |
| Git HEAD | `613ee13`（main，2026-11-10 15:26 feat(memory): load notebook details on demand） |

图谱数据实际落盘在 `C:\Users\ASUS\.cache\codebase-memory-mcp\<项目名>.db`，不在仓库里。

## 怎么更新图谱

工具调用（参数固定用这组，别改 `name`，否则会多出一份重复图谱）：

```
index_repository(repo_path='D:\aboutAI\记忆插件设计', mode='fast', name='dsh-memory-plugin', persistence=false)
```

- `mode=fast`：只建结构，不算相似度/语义边。这个项目日常够用；需要语义检索时才用 `moderate`/`full`。
- `persistence`：**中文路径一律 false**。

## 自动排除的目录（9 个）

`.git`、`.tmp`、`.tmp2`、`docs`、`scripts`、`packages/memory-plugin/bin`、`packages/memory-plugin/locale`、`native/memory-core/target`、`go-service/bin`

其中 **`docs`（156 节点）和 `scripts`（307 节点）是有内容的**，主图谱里查不到，已单独索引成两个项目：

| 图谱项目名 | 节点/边 | 根路径 | 索引时间 |
|---|---|---|---|
| `memplugin-docs` | 156/155 | `D:\aboutAI\记忆插件设计\docs` | 2026-11-10 10:52 |
| `memplugin-scripts` | 307/466 | `D:\aboutAI\记忆插件设计\scripts` | 2026-11-10 10:52 |

重建命令：

```
index_repository(repo_path='D:\aboutAI\记忆插件设计\docs',    mode='fast', name='memplugin-docs',    persistence=false)
index_repository(repo_path='D:\aboutAI\记忆插件设计\scripts', mode='fast', name='memplugin-scripts', persistence=false)
```

查文档/脚本时用这两个项目名，不要只查 `dsh-memory-plugin`。

**注意**：`memplugin-docs` 的 156 个节点全是 `Section`（Markdown 标题层级），正文内容不入图——按正文关键词查（如 FTS5、余弦、归一化）会返回 0 条，只能按标题词搜，或直接读文件。`memplugin-scripts` 则是正常函数图谱（check.mjs 的 run/collectJs 等 307 节点）。

## 同一路径下的图谱（只留最新）

| 项目名 | 节点/边 | 说明 |
|---|---|---|
| `dsh-memory-plugin` | 1217/3276 | **保留**，唯一主图谱 |
| `memplugin-docs` | 156/155 | docs 子目录，见上 |
| `memplugin-scripts` | 307/466 | scripts 子目录，见上 |

旧图谱 `memory-plugin-design`（682/1796）与 `D-aboutAI-e8aeb0e5bf86e68f92e4bbb6e8aebee8aea1`（1007/2681）已于 2026-11-10 11:04 用 `delete_project` 删除，避免误读旧图谱。

清理命令（再出现重复时照此走）：

```
delete_project(project='memory-plugin-design')
delete_project(project='D-aboutAI-e8aeb0e5bf86e68f92e4bbb6e8aebee8aea1')
```

判断「哪份最新」：看 `C:\Users\ASUS\.cache\codebase-memory-mcp\<项目名>.db` 的最后写入时间，或 `list_projects` 里的节点数。

## 坑（踩过的，别再踩）

1. **中文路径 + `persistence=true` = 索引 worker 崩溃**。报错 `{"status":"error","outcome":"exit_nonzero","hint":"Indexing worker crashed on a file..."}`，同一路径去掉 persistence 就正常。崩溃点是写 `.codebase-memory/graph.db.zst` 产物那一步，不是解析某个文件（zip、exe、10MB 的 memory-service.exe 单独索引都正常）。ASCII 路径（`D:\aboutAI\dshQQ`）带 persistence 成功，产物 2,033,162 字节。
2. **中文路径的 git 元数据失真**：MCP 记录 `git.root_exists=false`、`is_git=false`、`head_sha=null`，但目录实际存在且是 git 仓库（`git -C D:\aboutAI\记忆插件设计 log` 正常）。别信这两个字段，直接用 pwsh 跑 git 核对。
3. **图谱会漏新特性**：更新前 `search_graph(name_pattern='.*indexMode.*')` 返回 0 条，而 `packages/memory-plugin/lib/engine.js` 里 indexMode 已在行 78/142/1351/1382/1418/1468/1520/2361。所以守则第 1 条「有则更新一次再读」不是形式，是必需动作。
4. **`index_repository` 换 name 不会新建副本**：对同一 repo_path 用新 name 索引等价于「改名重建」，旧名自动消失。`name` 保持固定即可避免重复。
5. **新符号要先在图谱里搜得到再改**：渐进式加载这轮新增 `memory_notes`（工具）、`notesIndex`（引擎接口）、`notesIndexText`（返回 `{text,total,groupCount}`）三个符号。改完记得重刷图谱，否则下一个人读图谱会以为「插件只有 12 个工具、没有渐进式加载」——这正是守则第 1 条要防的坑。
