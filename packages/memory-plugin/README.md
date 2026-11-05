# dsh-memory-plugin

DSH（DeepSeek Harness）长期记忆插件：八层记忆体系、三本记事本、加权检索、自动反思维护，
外加一个装在「设置」里的可视化界面。

## 安装

在 DSH 中让 agent 执行：

```
plugin_manager action=install_bundle target=<本包绝对路径>
```

安装后新开一个会话即可生效（替换已安装版本需要重启 DSH）。

## 组成

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主入口：注册 6 个工具、系统提示词段落、定时维护、挂载 HTTP 接口 |
| `client.js` | 客户端设置页（`settings.section`，id=`memory-plugin`） |
| `lib/engine.js` | 记忆引擎：条目 CRUD、检索打分、冲突检测、维护任务、导出导入 |
| `lib/store.js` | JSON 存储：原子写、备份轮转、路径解析 |
| `lib/settings.js` | 设置结构（schema）、八层与三本记事本定义、归一化与补丁合并 |
| `lib/api.js` | 设置页调用的 HTTP 接口（前缀 `/dsh-memory-plugin/api/v2`） |
| `lib/tools.js` | agent 工具注册 |
| `locale/*.json` | 插件列表里的标题与描述 |

## 数据

默认写入 `%USERPROFILE%\.dsh\storages\dsh-memory-plugin\store.json`（可用 `DSH_HOME` 覆盖，
也可在设置页「存储」分组里改成任意目录）。写盘使用「临时文件 + rename」，并保留若干份
`store.json.bak-N`。

## 设置项

设置页按「通用 / 界面 / 存储 / 检索 / 写入 / 分层 / 提示词 / 维护 / 隐私 / 工具」分组，
可改完即存、可一键恢复默认。其中：

- `layers.*`：逐层开关，关掉后该层不再被读写
- `prompt.*`：是否注入系统提示词、每次注入几条、字数上限
- `maintenance.*`：自动维护间隔、保鲜期、归档天数、反思提升阈值、冲突阈值
- `tools.enabled`：是否向模型暴露记忆工具

## 许可

MIT
