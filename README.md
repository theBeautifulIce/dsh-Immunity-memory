# 记忆插件（dsh-memory-plugin）

给 DeepSeek Harness（DSH）加一套**跨会话的长期记忆**：八层记忆体系 + 三本记事本 + 加权检索 + 自动维护，
并带一个装在设置页里的可视化界面。

- 宿主侧：记忆引擎、6 个 agent 工具、系统提示词注入、定时维护、HTTP 接口
- 客户端侧：`设置 → 记忆` 一页搞定浏览、搜索、编辑、新建、批量操作、全部设置项、维护与导入导出
- 纯 JavaScript，无构建步骤、无原生依赖；记忆存在 **SQLite**（`node:sqlite`，零依赖），表结构对齐设计文档 §7.2，JSON 单文件作为显式可选/运行时回退

## 快速开始

```pwsh
# 1. 安装到当前桌面 profile（在 DSH 里让 agent 执行）
#    plugin_manager action=install_bundle target=D:\aboutAI\记忆插件设计\packages\memory-plugin

# 2. 打开任意会话的「设置」，左侧多出「记忆」一页
# 3. 或者直接让模型记东西：
#    “记住：这个仓库的测试命令是 node tests/api.test.mjs”
```

记忆库：`%USERPROFILE%\.dsh\storages\dsh-memory-plugin\memory.sqlite3`（表：memories / events / assets / relationships / changelog / config；路径与引擎可在设置页「存储」分组里改）。早期版本用的是同目录下的 `store.json`，首次启动会自动迁移进 SQLite。

## 仓库结构

```
.
├─ docs/
│  ├─ design/            # 需求与设计文档（原始输入）
│  │  ├─ 记忆插件实现设计.md
│  │  ├─ 记忆插件架构.md
│  │  └─ 记忆设计.txt
│  ├─ reference/         # 参考代码（gRPC / Go / Rust 方案）
│  │  ├─ 参考代码1.md
│  │  └─ 参考代码2.md
│  └─ 开发说明.md        # 架构、接口、数据模型、调试与发布
├─ packages/
│  └─ memory-plugin/     # 插件本体（可直接被 DSH 安装的包）
│     ├─ index.js        # 宿主入口：工具 / 提示词 / 维护定时器 / 接口挂载
│     ├─ client.js       # 客户端设置页（无构建，React.createElement）
│     ├─ lib/
│     │  ├─ settings.js  # 设置结构、分层与记事本定义、归一化
│     │  ├─ sqlite.js    # SQLite 存储（node:sqlite，按设计 §7.2 建表）
│     │  ├─ storage.js   # 存储选择：SQLite 优先，JSON 回退
│     │  ├─ store.js     # JSON 存储（显式可选引擎 / 回退）
│     │  ├─ engine.js    # 记忆引擎：增删改查、检索、冲突、维护、导出
│     │  ├─ api.js       # HTTP 接口 /dsh-memory-plugin/api/v2（供设置页调用）
│     │  └─ tools.js     # 6 个 agent 工具的注册
│     ├─ locale/         # 中英文展示元数据
│     ├─ icon.svg
│     └─ cordis.patch.yml
├─ scripts/
│  ├─ check.mjs          # 一键跑全部自检
│  └─ inspect-db.mjs     # 只读查看 SQLite 记忆库（表、行数、分层、最近条目）
└─ tests/
   ├─ engine.test.mjs    # 引擎单元测试
   ├─ tools.test.mjs     # 工具 schema 与执行测试
   ├─ sqlite.test.mjs    # SQLite 存储层（含旧 JSON 迁移、递归回归）
   ├─ api.test.mjs       # 接口端到端测试（真实 http server）
   └─ client.render.mjs  # 设置页渲染冒烟测试（真实 react-dom/server）
```

## 自检

```pwsh
node scripts/check.mjs          # 全部测试
node tests/engine.test.mjs      # 只跑引擎
node tests/tools.test.mjs       # 只跑工具
node tests/sqlite.test.mjs      # 只跑 SQLite 存储
node tests/api.test.mjs         # 只跑接口
node tests/client.render.mjs    # 只跑界面渲染
node scripts/inspect-db.mjs     # 看当前记忆库（加 --rows 列最近条目）
```

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 八层记忆 | L0 灵魂层（不可变）、L1 思想核心、L2 思想流动（冲突检测）、L3 本能行为、L4 学习行为、L5 目标记忆、L6 轮转记忆（保鲜期）、L7 情境感知 |
| 三本记事本 | 记忆记事本、日常记事本、资产记事本 |
| 检索 | 中英文分词 + 关键词加权（相关度、重要度、新鲜度、访问频次、置顶） |
| 写入保护 | 最小正文长度、去重（相似度阈值）、不可变层只读、L2 冲突检测 |
| 自动维护 | 过期清理 / 归档 / 去重 / 反思提升 / 压缩，按设置的间隔自动跑，也可手动触发 |
| 提示词注入 | 每轮把最相关的若干条记忆拼进系统提示词，可预览、可关闭 |
| 可视化界面 | 设置页内一页：列表 + 搜索 + 编辑器 + 全部设置项 + 维护 + 导入导出 + 审计日志 |
| 数据安全 | 单文件 JSON，原子写（临时文件 + rename），保留 N 份备份；可导出/导入 |

## 目录约定

- 设计文档进 `docs/`，代码进 `packages/`，测试进 `tests/`，一次性脚本进 `scripts/`。
- 运行期数据**不**进仓库（见 `.gitignore`），永远写在 DSH 的 `storages/` 下。
- 提交信息用 `类型: 摘要`，例如 `feat: 客户端记忆列表`、`fix: TTL 条目不过期`、`docs: 补充接口表`。

## 许可

MIT

