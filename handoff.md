# handoff：记忆插件设计（dsh-Immunity-memory）

> 面向下一个接手这个仓库的人（含 AI 助手）的注意事项。
> 本文件与 `codebasemap.md` 放在仓库根目录，随仓库一起走。
> 最后更新：2026-11-10 15:52

## 这是什么

DSH 的记忆插件本体，三层结构：

- `packages/memory-plugin/` — JS 插件层，Duck/LSP 侧入口，`lib/engine.js` 是核心（检索、注入、写库编排）
- `go-service/` — Go 服务，`cmd/memory-service/main.go` 是进程入口，提供 HTTP API（`/search`、`/items/upsert`、`/audit/append`、`/graph/bfs` 等 19 条路由）、SQLite(FTS5)+ 向量余弦 + 图谱 BFS 三路检索融合
- `native/memory-core/` — Rust 原生模块，只干向量余弦（约 3.09 万对/秒）

上游仓库：`https://github.com/theBeautifulIce/dsh-Immunity-memory.git`（origin，分支 main）

## 当前状态：已发布 v0.4.29，已重启上线并验收通过

HEAD = `dff79ea`（docs: point codebasemap at acb171d），功能提交是 `613ee13`（feat(memory): load notebook details on demand），tag `v0.4.29`。20 个文件、+984/-57，含新测试 `tests/index-mode.test.mjs`、`tests/notes-index.test.mjs`，以及重新构建的 Go 服务二进制（`packages/memory-plugin/bin/win32-x64/memory-service.exe`，sha256 前缀 6df9efeb817cb05e）。

已发布：2026-11-10 15:47 推送 `main`（a5e598b..dff79ea，5 个提交）与 tag `v0.4.29`，GitHub Release v0.4.29 已上线（Latest），附件 `dsh-memory-plugin-0.4.29.zip`（5,047,389 字节，下载后 sha256 校验一致：F02710AB…73167）。发布说明覆盖 0.4.26–0.4.29 四段，因为上一个已发布版本是 v0.4.25（v0.4.26 只有 tag、没有 release）。

DSH 已于 2026-11-10 15:30 重启，线上跑的已是新注入：注入正文 9794 字 / 6700 token，末尾只挂「### 记事本目录（4 类，共 66 条）」分类目录（182 字），不再有 66 条标题清单（改前 13582 字 / 8466 token、清单 3967 字）。宿主 GUI 端口在重启后变为 `60893`。

主线一「记忆索引模式」（indexMode）：记忆条目只留一行要点，细节放记事本，条目用 `refs` 指过去。0.4.28 起随本次提交一起落地。

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
9. **Go 服务二进制要跟着改一起重建**：`go-service/internal/store/store.go` 改了字段（refs / indexMode）就得跑 `node scripts/build-go.mjs` 重新生成 `packages/memory-plugin/bin/<platform>-<arch>/memory-service.exe`，插件启动时才会把新二进制铺到 `<DSH_HOME>/storages/dsh-memory-plugin/service/`。不重建，Go 侧读库就丢这两个字段（Node 回退层不受影响，所以本地测试照样过）。
10. **Go 代码改动先过 gofmt**：`D:\GO\bin\gofmt.exe -l <file>` 应输出空；缩进用 Tab，手工插行容易写成空格导致 `expected ';', found '{'` 之类的语法错。
11. **改 Go 代码别用 PowerShell 内插字符串硬改**：`store.go` 这轮用 pwsh 写回时被中文与反引号搞坏，报 ParserError / gofmt 语法错。改法：`git checkout` 还原后用 `mcp__fstools__edit_file` 做行级编辑。

## 发布流程（2026-11-10 走过一遍，v0.4.29）

1. 改 `packages/memory-plugin/package.json` 的 version，并在 `CHANGELOG.md` 顶部写新版本段。
2. 重建 Windows 二进制：`node scripts/build-go.mjs`（Go 侧）；Rust 没改就别动 `native/` 里的 `memory-core.exe`。
3. `node scripts/check.mjs` 全绿再往下走。
4. 打包 zip：目录结构必须是 `dsh-memory-plugin/` 前缀，内容 = `package.json` 的 `files` 列表 + `bin/win32-x64/memory-service.exe` + `native/win32-x64/memory-core.exe`；仓库里没有打包脚本，这一步是手工 Compress-Archive（先在 `.tmp\pkg-<ver>\` 暂存再压，`.tmp` 是 gitignore 的）。
5. 提交 → `git tag -a vX.Y.Z -m "vX.Y.Z: 一句话说明"` → 推 main 与 tag。
6. `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <说明.md> <zip>`，说明 = CHANGELOG 从新版本段到上一个已发布版本段（这次是 0.4.26–0.4.29 四段，因为上一个已发布的是 v0.4.25）+ 中文安装行。
7. 发布后把附件下载回来对 sha256，确认上传的没坏。

推 GitHub 的两条避坑：
- 一切都走本地代理 `http://127.0.0.1:7078`（`$env:HTTPS_PROXY` / `-c http.proxy=`）。
- `git push` 别让 GCM 弹窗（历史上会挂死）：用 `gh auth token` 取 token，自己拼 `http.extraHeader=Authorization: Basic base64(theBeautifulIce:TOKEN)`，并加 `-c credential.helper=`，先 `--dry-run` 再真推。

## 别做的事

- 别在 DSH 运行时对该目录跑 `pnpm install`——会毁掉 node_modules。
- 别改 `package.json` 之外再去改 hook 权限那条路（QQ 报「文件已损坏」的真因是 hook 没提权，不是 package.json）。
- 别用 `window.prompt`——插件里会让按钮「点了没反应」。
- 别混行尾：`lib/engine.js`、`lib/tools.js`、`lib/settings.js`、`client.js` 是 LF；`lib/api.js`、`tests/tools.test.mjs` 是 CRLF。编辑时保持原样，否则 diff 会炸成整文件。
