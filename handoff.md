# handoff：记忆插件设计（dsh-Immunity-memory）

> 面向下一个接手这个仓库的人（含 AI 助手）的注意事项。
> 本文件与 `codebasemap.md` 放在仓库根目录，随仓库一起走。
> 最后更新：2026-11-10 15:18

## 这是什么

DSH 的记忆插件本体，三层结构：

- `packages/memory-plugin/` — JS 插件层，Duck/LSP 侧入口，`lib/engine.js` 是核心（检索、注入、写库编排）
- `go-service/` — Go 服务，`cmd/memory-service/main.go` 是进程入口，提供 HTTP API（`/search`、`/items/upsert`、`/audit/append`、`/graph/bfs` 等 19 条路由）、SQLite(FTS5)+ 向量余弦 + 图谱 BFS 三路检索融合
- `native/memory-core/` — Rust 原生模块，只干向量余弦（约 3.09 万对/秒）

上游仓库：`https://github.com/theBeautifulIce/dsh-Immunity-memory.git`（origin，分支 main）

## 当前状态：工作区有未提交改动

HEAD = `69a6d831374ea5a696df62c781f19f81fea695ad`（2026-11-10 11:31:55 docs: add handoff and codebasemap for maintainers）

已修改：`CHANGELOG.md`、`README.md`、`README.en.md`、`docs/开发说明.md`、`go-service/internal/store/store.go`、`packages/memory-plugin/{client.js,lib/api.js,lib/engine.js,lib/settings.js,lib/sqlite.js,lib/tools.js,package.json}`、`scripts/check.mjs`、`tests/{client.render.mjs,tools.test.mjs}`
未跟踪：`tests/index-mode.test.mjs`、`tests/notes-index.test.mjs`

主线是「记忆索引模式」（indexMode）：记忆条目只留一行要点，细节放记事本，条目用 `refs` 指过去。版本号已 bump 到 0.4.28，**尚未提交/发布**，DSH 已重启、线上生效。

本次新增的第二条主线是「记事本渐进式加载」（0.4.29）：记事本条目不再常驻注入，提示词末尾只挂一份分类目录（每本一行「- pitfall 踩坑笔记（42 条）」），标题清单改由新工具 `memory_notes` 按本 / 关键词按需拉取，再用 `memory_get(id)` 取正文。改这一条必须重启 DSH 才生效。

关键落点：
- `packages/memory-plugin/lib/engine.js`：`notesIndexText()` 现在只产出分类目录；新增 `notesIndex(options)`（引擎接口，返回 id/标题/一行摘要/`referenced`）；`TOOL_NAMES` 增 `memory_notes`（共 13 个）。
- `packages/memory-plugin/lib/tools.js`：新工具 `memory_notes` + `notesOutput` 渲染。
- `packages/memory-plugin/lib/settings.js`：三个模板 header 第 3 行统一改成「先用 memory_notes 列索引，再用 memory_get(id) 取全文」。
- `packages/memory-plugin/lib/api.js`：新增 API 方法 `notes.index`。
- `packages/memory-plugin/client.js`：面板「记事本目录」卡片文案改为分类计数口径。
- 测试：`tests/notes-index.test.mjs`（新，8 断言）、`tests/index-mode.test.mjs`（★ 断言改成目录/`referenced` 断言）、`tests/tools.test.mjs`（12→13 个工具）。

## 动手前必看

1. **先更新图谱再读代码**。图谱会落后于源码（indexMode 就是例子），见同目录 `codebasemap.md`。
2. **`docs/` 和 `scripts/` 不在主图谱里**，需要时单独索引。
3. **同一路径只保留最新的一份图谱**。重复图谱会造成误读，发现同名/近名副本就用 `delete_project` 删旧的；改代码前后各 `list_projects` 对一次。
4. **改完插件代码要重启 DSH 才生效**，否则 bootstrap 仍返回旧注入。
5. **提交前跑** `scripts/check.mjs`（含 `tests/index-mode.test.mjs` 与 `tests/notes-index.test.mjs`）。
6. **GitHub 访问必须走本地代理** `http://127.0.0.1:7078`（直连 1MB 约 85 秒）。pwsh 里 `Invoke-WebRequest -Proxy 'http://127.0.0.1:7078'`；git 用 `git -c http.proxy=http://127.0.0.1:7078`。
7. **`memory_*` 写入三约束**：笔记要带 layer、更新要带全文、L3 只读。
8. **要改模板层（L0/L1/L3）**：memory_write 写不了 L3，但能走宿主 API —— `POST http://127.0.0.1:59612/dsh-memory-plugin/api/v2`，method `templates.list` 导出整份模板备份、`templates.save` 只替换目标层（其余原样回传），改后逐条比对 title+content 并用 `prompt.preview` 复核注入文本。改前务必先备份。

## 别做的事

- 别在 DSH 运行时对该目录跑 `pnpm install`——会毁掉 node_modules。
- 别改 `package.json` 之外再去改 hook 权限那条路（QQ 报「文件已损坏」的真因是 hook 没提权，不是 package.json）。
- 别用 `window.prompt`——插件里会让按钮「点了没反应」。
- 别混行尾：`lib/engine.js`、`lib/tools.js`、`lib/settings.js`、`client.js` 是 LF；`lib/api.js`、`tests/tools.test.mjs` 是 CRLF。编辑时保持原样，否则 diff 会炸成整文件。
