/**
 * dsh-memory-plugin 的客户端设置页。
 *
 * 无构建步骤：整个文件就是浏览器直接执行的模块，只依赖 DSH 注入的 `react`。
 * 落点有两个：
 *   - `sidebar.panellist` + `main`：左侧栏的一枚图标，点开就是整页记忆库（主入口）；
 *   - `settings.section`：设置面板里的一页（保留，方便从设置直达）。
 *
 * 数据全部来自宿主接口 `/memory-plugin/api`（lib/api.js），与模型工具共用同一个引擎。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-plugin',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    // 接口前缀：新路径优先，旧前缀只作兼容（旧前缀可能被上一代插件的路由占着，
    // 那条路由读的是上一代的数据，所以必须把新路径排在前面）。
    const API_PATHS = ['/dsh-memory-plugin/api/v2', '/memory-plugin/api/v2', '/memory-plugin/api']
    const NS = 'dsh-memory-plugin'
    const STYLE_ID = 'dsh-memory-plugin-style'

    // ------------------------------------------------------------ 接口通道 --

    function apiCandidates() {
      const list = []
      const streamBase = globalThis.__DSH_TRANSPORT__?.streamBaseUrl
      for (const path of API_PATHS) {
        try {
          list.push(new URL(path, window.location.origin).toString())
        } catch {
          /* 忽略 */
        }
        try {
          if (document.baseURI) list.push(new URL(path.replace(/^\//, ''), document.baseURI).toString())
        } catch {
          /* 忽略 */
        }
        if (typeof streamBase === 'string' && streamBase !== '') {
          try {
            list.push(new URL(path.replace(/^\//, ''), streamBase).toString())
          } catch {
            /* 忽略 */
          }
        }
        list.push(path)
      }
      return [...new Set(list)]
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        const error = new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`)
        error.code = 'bad_response'
        throw error
      }
      if (!response.ok || parsed === null || typeof parsed !== 'object' || parsed.ok !== true) {
        const error = new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
        error.code = parsed?.error?.code ?? `http_${response.status}`
        error.status = response.status
        throw error
      }
      return parsed.value
    }

    function createApi() {
      let endpoint = null
      return async function call(method, params) {
        const body = { method, params: params ?? {} }
        if (endpoint !== null) {
          try {
            return await postJson(endpoint, body)
          } catch (error) {
            // 只有"连不上"才允许换地址重试，避免写操作被执行两次。
            if (error instanceof TypeError) {
              endpoint = null
            } else {
              throw error
            }
          }
        }
        let lastError
        for (const url of apiCandidates()) {
          try {
            const value = await postJson(url, body)
            endpoint = url
            return value
          } catch (error) {
            lastError = error
            if (typeof error.status === 'number' && error.status < 500) {
              // 服务器明确报错（400/403/404），换地址也没用，直接抛出。
              throw error
            }
          }
        }
        throw lastError ?? new Error('无法连接记忆插件接口')
      }
    }

    const api = createApi()

    // ------------------------------------------------------------ 样式 ----

    const CSS = `
      .mp-root { display:flex; flex-direction:column; gap:12px; font-size:13px; line-height:1.5;
        color:var(--dsw-alias-label-primary,#1f2329); padding-bottom:12px }
      /* 侧边栏整页入口：沿用设置页的面板，但列表随视口长高，别停在 540px。 */
      .mp-page .mp-root { min-height:100% }
      .mp-page .mp-list { max-height:min(680px, calc(100vh - 300px)) }
      .mp-page .mp-list-plain { max-height:min(420px, calc(100vh - 380px)) }
      .mp-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap }
      .mp-title { font-size:16px; font-weight:650; letter-spacing:.01em }
      .mp-sub { color:var(--dsw-alias-label-secondary,#6b7280); font-size:12px; margin-top:2px }
      .mp-badges { display:flex; gap:6px; flex-wrap:wrap }
      .mp-badge { padding:2px 8px; border-radius:999px; font-size:11px;
        background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.06)); color:var(--dsw-alias-label-secondary,#6b7280) }
      .mp-tabs { display:flex; gap:2px; border-bottom:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.1)); flex-wrap:wrap }
      .mp-tab { appearance:none; border:none; background:transparent; cursor:pointer; padding:7px 12px;
        font-size:13px; color:var(--dsw-alias-label-secondary,#6b7280);
        border-bottom:2px solid transparent; font-family:inherit }
      .mp-tab:hover { color:var(--dsw-alias-label-primary,#1f2329) }
      .mp-tab.is-active { color:var(--dsw-alias-label-primary,#1f2329); font-weight:600;
        border-bottom-color:var(--dsw-alias-brand-primary,#3b82f6) }
      .mp-panel { display:flex; flex-direction:column; gap:12px }
      .mp-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap }
      .mp-input,.mp-select,.mp-textarea { box-sizing:border-box; font-family:inherit; font-size:13px;
        color:var(--dsw-alias-label-primary,#1f2329); background:var(--dsw-alias-bg-layer-1,#fff);
        border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.14)); border-radius:8px; padding:6px 9px; outline:none }
      .mp-input:focus,.mp-select:focus,.mp-textarea:focus { border-color:var(--dsw-alias-brand-primary,#3b82f6) }
      .mp-textarea { resize:vertical; min-height:96px; line-height:1.6 }
      .mp-input.is-grow { flex:1 1 240px; min-width:180px }
      .mp-btn { appearance:none; font-family:inherit; font-size:13px; cursor:pointer; border-radius:8px;
        padding:6px 12px; border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.14));
        background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2329);
        transition:background .12s ease }
      .mp-btn:hover { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.06)) }
      .mp-btn[disabled] { opacity:.5; cursor:not-allowed }
      .mp-btn.is-primary { background:var(--dsw-alias-brand-primary,#3b82f6); border-color:transparent; color:#fff }
      .mp-btn.is-primary:hover { filter:brightness(1.05) }
      .mp-btn.is-danger { color:var(--dsw-alias-state-error-primary,#dc2626);
        border-color:var(--dsw-alias-state-error-primary,#dc2626) }
      .mp-btn.is-ghost { border-color:transparent; background:transparent }
      .mp-split { display:flex; gap:12px; align-items:flex-start; flex-wrap:wrap }
      .mp-list { flex:1 1 340px; min-width:280px; max-height:540px; overflow:auto; border-radius:10px;
        border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.1));
        background:var(--dsw-alias-bg-layer-1,#fff) }
      .mp-row { padding:9px 11px; border-bottom:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.07));
        cursor:pointer; display:flex; flex-direction:column; gap:3px }
      .mp-row:last-child { border-bottom:none }
      .mp-row:hover { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04)) }
      .mp-row.is-active { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.06));
        box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#3b82f6) }
      .mp-row-title { font-weight:600; display:flex; align-items:center; gap:6px; flex-wrap:wrap }
      .mp-row-meta { font-size:11px; color:var(--dsw-alias-label-tertiary,#9ca3af); display:flex; gap:8px; flex-wrap:wrap }
      .mp-row-body { font-size:12px; color:var(--dsw-alias-label-secondary,#6b7280);
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden }
      .mp-chip { font-size:11px; padding:1px 6px; border-radius:6px;
        background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.06)) }
      .mp-chip.is-warn { color:var(--dsw-alias-state-warning-primary,#b45309) }
      .mp-chip.is-bad { color:var(--dsw-alias-state-error-primary,#dc2626) }
      /* 分层徽章：颜色 + 粗体，扫列表时先看到层，不必读正文。 */
      .mp-layer-badge { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:700;
        padding:1px 7px; border-radius:6px; border:1px solid transparent; letter-spacing:.02em }
      .mp-layer-badge::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor }
      .mp-layer-badge.is-large { font-size:12px; padding:3px 9px }
      .mp-layer-badge.is-l0 { color:#7c3aed; background:rgba(124,58,237,.12); border-color:rgba(124,58,237,.28) }
      .mp-layer-badge.is-l1 { color:#4f46e5; background:rgba(79,70,229,.12); border-color:rgba(79,70,229,.28) }
      .mp-layer-badge.is-l2 { color:#2563eb; background:rgba(37,99,235,.12); border-color:rgba(37,99,235,.28) }
      .mp-layer-badge.is-l3 { color:#0d9488; background:rgba(13,148,136,.12); border-color:rgba(13,148,136,.28) }
      .mp-layer-badge.is-l4 { color:#16a34a; background:rgba(22,163,74,.12); border-color:rgba(22,163,74,.28) }
      .mp-layer-badge.is-l5 { color:#b45309; background:rgba(180,83,9,.12); border-color:rgba(180,83,9,.28) }
      .mp-layer-badge.is-l6 { color:#ea580c; background:rgba(234,88,12,.12); border-color:rgba(234,88,12,.28) }
      .mp-layer-badge.is-l7 { color:#475569; background:rgba(71,85,105,.12); border-color:rgba(71,85,105,.28) }
      .mp-inject { gap:8px }
      .mp-inject-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap }
      .mp-inject-main { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap }
      .mp-inject-tokens { font-size:22px; font-weight:750; line-height:1.1; letter-spacing:-.02em }
      .mp-inject-unit { font-size:11px; color:var(--dsw-alias-label-tertiary,#9ca3af) }
      .mp-meter { height:7px; border-radius:999px; overflow:hidden;
        background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.08)); display:flex }
      .mp-meter span { height:100%; display:block }
      .mp-meter span.is-l0 { background:#7c3aed } .mp-meter span.is-l1 { background:#4f46e5 }
      .mp-meter span.is-l2 { background:#2563eb } .mp-meter span.is-l3 { background:#0d9488 }
      .mp-meter span.is-l4 { background:#16a34a } .mp-meter span.is-l5 { background:#b45309 }
      .mp-meter span.is-l6 { background:#ea580c } .mp-meter span.is-l7 { background:#475569 }
      .mp-meter span.is-header { background:var(--dsw-alias-label-tertiary,#9ca3af) }
      .mp-layer-table { display:grid; grid-template-columns:1fr auto auto; gap:4px 10px; align-items:center; font-size:12px }
      .mp-layer-table .mp-hint { font-size:11px }
      .mp-bar { height:5px; border-radius:999px; background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.08)); overflow:hidden }
      .mp-bar span { display:block; height:100% }
      .mp-bar span.is-l0 { background:#7c3aed } .mp-bar span.is-l1 { background:#4f46e5 }
      .mp-bar span.is-l2 { background:#2563eb } .mp-bar span.is-l3 { background:#0d9488 }
      .mp-bar span.is-l4 { background:#16a34a } .mp-bar span.is-l5 { background:#b45309 }
      .mp-bar span.is-l6 { background:#ea580c } .mp-bar span.is-l7 { background:#475569 }
      .mp-usage-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px }
      .mp-kpi { border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.1)); border-radius:8px; padding:8px 10px }
      .mp-kpi b { display:block; font-size:18px; line-height:1.2 }
      .mp-consolidate-row { border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.1)); border-radius:8px; padding:8px 10px;
        display:flex; flex-direction:column; gap:6px }
      .mp-ttl-alert { border-left:3px solid var(--dsw-alias-state-warning-primary,#b45309); padding:5px 8px;
        background:rgba(180,83,9,.08); border-radius:6px; font-size:11px; color:var(--dsw-alias-state-warning-primary,#b45309) }
      .mp-editor { flex:1 1 420px; min-width:300px; display:flex; flex-direction:column; gap:10px;
        border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.1)); border-radius:10px; padding:12px;
        background:var(--dsw-alias-bg-layer-1,#fff) }
      .mp-field { display:flex; flex-direction:column; gap:4px }
      .mp-label { font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary,#4b5563) }
      .mp-hint { font-size:11px; color:var(--dsw-alias-label-tertiary,#9ca3af); line-height:1.45 }
      .mp-grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px }
      .mp-card { border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.1)); border-radius:10px;
        padding:12px; background:var(--dsw-alias-bg-layer-1,#fff); display:flex; flex-direction:column; gap:10px }
      .mp-card-title { font-size:13px; font-weight:650 }
      .mp-empty { padding:26px 14px; text-align:center; color:var(--dsw-alias-label-tertiary,#9ca3af); font-size:12px }
      .mp-toast { padding:7px 10px; border-radius:8px; font-size:12px;
        background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.06));
        color:var(--dsw-alias-label-primary,#1f2329); border-left:3px solid var(--dsw-alias-brand-primary,#3b82f6) }
      .mp-toast.is-error { border-left-color:var(--dsw-alias-state-error-primary,#dc2626) }
      .mp-switch { display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px }
      .mp-switch input { width:15px; height:15px; accent-color:var(--dsw-alias-brand-primary,#3b82f6) }
      .mp-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
        color:var(--dsw-alias-label-secondary,#6b7280); word-break:break-all }
      .mp-list-plain { display:flex; flex-direction:column; gap:6px; max-height:260px; overflow:auto }
      .mp-audit { font-size:11px; color:var(--dsw-alias-label-secondary,#6b7280);
        display:flex; gap:8px; border-bottom:1px dashed var(--dsw-alias-border-l2,rgba(15,23,42,.1)); padding:4px 0 }
      .mp-group-head { font-size:12px; font-weight:700; letter-spacing:.02em;
        color:var(--dsw-alias-label-secondary,#4b5563); text-transform:none }
      .mp-pager { display:flex; gap:8px; align-items:center; justify-content:flex-end; font-size:11px;
        color:var(--dsw-alias-label-tertiary,#9ca3af) }
      .mp-layers { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:8px }
      .mp-layer { border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.1)); border-radius:8px; padding:8px 10px;
        display:flex; align-items:center; justify-content:space-between; gap:8px }
      .mp-layer-name { font-size:12px; font-weight:600 }
      .mp-layer-desc { font-size:11px; color:var(--dsw-alias-label-tertiary,#9ca3af) }
    `

    function installStyles(ctx) {
      try {
        const styles = typeof ctx?.get === 'function' ? ctx.get('styles') : undefined
        if (styles !== undefined && styles !== null && typeof styles.insert === 'function') {
          styles.insert(CSS)
          return
        }
      } catch {
        /* 退回手动注入 */
      }
      try {
        if (typeof document === 'undefined' || document.head === null) return
        if (document.getElementById(STYLE_ID) !== null) {
          document.getElementById(STYLE_ID).textContent = CSS
          return
        }
        const element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = CSS
        document.head.appendChild(element)
      } catch {
        /* 样式失败不影响功能 */
      }
    }

    // ------------------------------------------------------------ 小工具 ----

    function resolveLang(settings) {
      const pref = settings?.ui?.language ?? 'auto'
      if (pref === 'zh' || pref === 'en') return pref
      const nav = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : ''
      return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function labelOf(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'object') return value.zh ?? value.en ?? ''
      return String(value)
    }

    function cloneJson(value) {
      try {
        return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
      } catch {
        return JSON.parse(JSON.stringify(value))
      }
    }

    function getPath(target, path) {
      if (target === null || typeof target !== 'object') return undefined
      let current = target
      for (const key of String(path).split('.')) {
        if (current === null || typeof current !== 'object') return undefined
        current = current[key]
      }
      return current
    }

    function setPath(target, path, value) {
      const keys = String(path).split('.')
      let current = target
      for (let index = 0; index < keys.length - 1; index += 1) {
        if (current[keys[index]] === null || typeof current[keys[index]] !== 'object') current[keys[index]] = {}
        current = current[keys[index]]
      }
      current[keys[keys.length - 1]] = value
      return target
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(2)} MB`
    }

    function StatusChip({ lang, item }) {
      const chips = []
      if (item.pinned) chips.push(h('span', { key: 'pin', className: 'mp-chip' }, lang === 'zh' ? '置顶' : 'pinned'))
      if (item.status === 'archived') chips.push(h('span', { key: 'arch', className: 'mp-chip' }, lang === 'zh' ? '已归档' : 'archived'))
      if (item.status === 'expired') chips.push(h('span', { key: 'exp', className: 'mp-chip is-warn' }, lang === 'zh' ? '已过期' : 'expired'))
      if (item.status === 'conflicted') chips.push(h('span', { key: 'con', className: 'mp-chip is-bad' }, lang === 'zh' ? '冲突' : 'conflict'))
      if (chips.length === 0) return null
      return h('span', { style: { display: 'inline-flex', gap: '4px' } }, chips)
    }

    function LayerBadge({ item, large }) {
      const layer = String(item?.layer ?? 'L5')
      const name = labelOf(item?.layerName)
      return h('span', {
        className: `mp-layer-badge is-${layer.toLowerCase()}${large === true ? ' is-large' : ''}`,
        title: `${layer} ${name}`.trim(),
      }, `${layer}${name === '' ? '' : ` ${name}`}`)
    }

    // ------------------------------------------------------------ 主组件 ----

    /**
     * 顶部注入预算卡：默认只看总 token，展开后按层拆分。
     * 模板切换直接写 settings.prompt.template，系统提示词下一轮就按新模板生成。
     */
    function InjectionCard({ api, lang, boot, notify, onChanged }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const injection = boot.injection ?? {}
      const templates = boot.templates?.list ?? []
      const [expanded, setExpanded] = useState(false)
      const [saving, setSaving] = useState(false)
      const [templateId, setTemplateId] = useState(boot.settings?.prompt?.template ?? injection.template?.id ?? 'default')

      useEffect(() => {
        setTemplateId(boot.settings?.prompt?.template ?? injection.template?.id ?? 'default')
      }, [boot.settings?.prompt?.template, injection.template?.id])

      async function switchTemplate(next) {
        setTemplateId(next)
        setSaving(true)
        try {
          await api('settings.save', { patch: { prompt: { template: next } } })
          notify(txt('模板已切换，下一轮对话立即生效', 'Template switched; takes effect on the next turn'))
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setSaving(false)
        }
      }

      const layers = injection.layers ?? []
      const total = injection.tokens ?? 0
      const maxChars = injection.maxChars ?? 0
      const headerTokens = injection.headerTokens ?? 0
      const headerPercent = injection.headerPercent ?? 0
      const charPercent = maxChars > 0 ? Math.min(100, ((injection.chars ?? 0) / maxChars) * 100) : 0
      const activeName = injection.template?.name
      const activeLabel = typeof activeName === 'object' ? labelOf(activeName) : (activeName ?? templateId)

      return h('div', { className: 'mp-card mp-inject' },
        h('div', { className: 'mp-inject-head' },
          h('div', null,
            h('div', { className: 'mp-card-title' }, txt('当前记忆注入消耗', 'Current memory injection cost')),
            h('div', { className: 'mp-inject-main' },
              h('span', { className: 'mp-inject-tokens' }, total.toLocaleString()),
              h('span', { className: 'mp-inject-unit' }, txt('token', 'tokens')),
              h('span', { className: 'mp-hint' }, txt(
                `${injection.itemCount ?? 0} 条 · 字符 ${injection.chars ?? 0}/${maxChars || '不限'}${injection.truncated ? ' · 已截断' : ''}`,
                `${injection.itemCount ?? 0} items · ${injection.chars ?? 0}/${maxChars || 'unlimited'} chars${injection.truncated ? ' · truncated' : ''}`)))),
          h('div', { className: 'mp-toolbar' },
            h('select', {
              className: 'mp-select',
              value: templateId,
              disabled: saving,
              title: txt('记忆模板（保存后立即生效）', 'Memory template (applies immediately)'),
              onChange: (event) => switchTemplate(event.target.value),
            }, templates.map((entry) => h('option', { key: entry.id, value: entry.id },
              `${labelOf(entry.name)}${entry.id === templateId ? '' : ''}`))),
            h('button', {
              type: 'button',
              className: 'mp-btn',
              onClick: () => setExpanded((value) => !value),
            }, expanded ? txt('收起分层', 'Hide layers') : txt('展开分层', 'Show layers')))),
        h('div', { className: 'mp-hint' },
          `${txt('模板', 'template')} ${activeLabel} · ${txt('估算口径', 'estimate')}：CJK 1 字≈1 token，其它 4 字符≈1 token${injection.enabled ? '' : txt(' · 注入已关闭', ' · injection is off')}`),
        h('div', { className: 'mp-meter', title: `${charPercent.toFixed(1)}%` },
          headerPercent > 0 ? h('span', {
            className: 'is-header',
            title: `${txt('模板头', 'header')} ${headerTokens} token`,
            style: { width: `${headerPercent}%` },
          }) : null,
          layers.filter((layer) => (layer.tokens ?? 0) > 0).map((layer) => h('span', {
            key: layer.id,
            className: `is-${layer.id.toLowerCase()}`,
            style: { width: `${Math.max(1, layer.percent ?? 0)}%` },
          }))),
        expanded
          ? h('div', { className: 'mp-layer-table' },
            headerTokens > 0 ? h('div', { style: { display: 'contents' } },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h('span', { className: 'mp-chip' }, txt('模板头', 'header'))),
              h('span', { style: { textAlign: 'right', fontWeight: 600 } }, `${headerTokens}`),
              h('span', { className: 'mp-hint' }, `${headerPercent}%`)) : null,
            layers.map((layer) => h('div', { key: layer.id, style: { display: 'contents' } },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h('span', { className: `mp-layer-badge is-${layer.id.toLowerCase()}` }, layer.id),
                h('span', null, labelOf(layer.name)),
                layer.count === 0 ? h('span', { className: 'mp-hint' }, txt('未注入', 'none')) : null),
              h('span', { style: { textAlign: 'right', fontWeight: 600 } }, `${layer.tokens ?? 0}`),
              h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: '90px' } },
                h('span', { className: 'mp-bar', style: { flex: 1 } },
                  h('span', { className: `is-${layer.id.toLowerCase()}`, style: { width: `${Math.max(0, Math.min(100, layer.percent ?? 0))}%` } })),
                h('span', { className: 'mp-hint' }, `${layer.percent ?? 0}%`)))))
          : null,
        h('div', { className: 'mp-hint' }, txt(
          '这是按注入文本估算的消耗，用于控制上下文预算；不是模型计费 token 的精确值。',
          'Estimated from the injected text to control the context budget; not an exact billing token count.')))
    }

    function MemorySettingsPage() {
      const [boot, setBoot] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [tab, setTab] = useState('memory')
      const [toast, setToast] = useState(null)
      const toastTimer = useRef(null)

      const notify = useCallback((text, kind) => {
        setToast({ text, kind: kind ?? 'info' })
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3600)
      }, [])

      const refreshBoot = useCallback(async () => {
        try {
          const value = await api('bootstrap')
          setBoot(value)
          setLoadError('')
          return value
        } catch (error) {
          setLoadError(error.message)
          return null
        }
      }, [])

      useEffect(() => {
        let alive = true
        api('bootstrap')
          .then((value) => {
            if (alive) setBoot(value)
          })
          .catch((error) => {
            if (alive) setLoadError(error.message)
          })
        return () => {
          alive = false
        }
      }, [])

      const lang = resolveLang(boot?.settings)
      const txt = (zh, en) => (lang === 'zh' ? zh : en)

      if (boot === null) {
        return h('div', { className: 'mp-root' },
          h('div', { className: 'mp-head' },
            h('div', null,
              h('div', { className: 'mp-title' }, txt('记忆', 'Memory')),
              h('div', { className: 'mp-sub' }, loadError === ''
                ? txt('正在读取记忆库…', 'Loading the memory store…')
                : txt(`无法连接宿主接口：${loadError}`, `Cannot reach the host: ${loadError}`)))))
      }

      const settings = boot.settings
      const stats = boot.stats ?? {}
      const tabs = [
        { id: 'memory', label: txt('记忆', 'Memories'), count: stats.memories ?? 0 },
        { id: 'note', label: txt('记事本', 'Notebooks'), count: stats.notes ?? 0 },
        { id: 'usage', label: txt('用量', 'Usage') },
        { id: 'consolidate', label: txt('固化', 'Consolidate'), count: boot.consolidation?.candidates?.length ?? 0 },
        { id: 'settings', label: txt('设置', 'Settings') },
        { id: 'maintenance', label: txt('维护', 'Maintenance') },
      ]

      return h('div', { className: 'mp-root' },
        h('div', { className: 'mp-head' },
          h('div', null,
            h('div', { className: 'mp-title' }, txt('记忆', 'Memory')),
            h('div', { className: 'mp-sub' }, txt(
              '跨会话记住偏好、事实与决定；模型通过 memory_* 工具读写，你在这里查看和修改。',
              'Keeps preferences, facts and decisions across sessions. The model reads and writes through memory_* tools; you curate them here.',
            ))),
          h('div', { className: 'mp-badges' },
            h('span', { className: 'mp-badge' }, `${txt('总计', 'total')} ${stats.total ?? 0}`),
            h('span', { className: 'mp-badge' }, `${txt('记忆', 'memories')} ${stats.memories ?? 0}`),
            h('span', { className: 'mp-badge' }, `${txt('记事', 'notes')} ${stats.notes ?? 0}`),
            stats.byStatus?.conflicted > 0
              ? h('span', { className: 'mp-badge', style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)' } },
                `${txt('冲突', 'conflicts')} ${stats.byStatus.conflicted}`)
              : null,
            h('span', { className: 'mp-badge' }, settings.enabled ? txt('已启用', 'enabled') : txt('已停用', 'disabled')))),
        h(InjectionCard, { api, lang, boot, notify, onChanged: refreshBoot }),
        h('div', { className: 'mp-tabs' }, tabs.map((entry) => h('button', {
          key: entry.id,
          type: 'button',
          className: `mp-tab${tab === entry.id ? ' is-active' : ''}`,
          onClick: () => setTab(entry.id),
        }, entry.count === undefined ? entry.label : `${entry.label} ${entry.count}`))),
        toast === null ? null : h('div', { className: `mp-toast${toast.kind === 'error' ? ' is-error' : ''}` }, toast.text),
        tab === 'memory' || tab === 'note'
          ? h(ItemBrowser, {
            key: tab,
            api,
            lang,
            settings,
            kind: tab,
            notify,
            onChanged: refreshBoot,
          })
          : null,
        tab === 'settings'
          ? h(SettingsPanel, {
            api,
            lang,
            boot,
            notify,
            onSaved: refreshBoot,
          })
          : null,
        tab === 'usage'
          ? h(UsagePanel, { api, lang, boot, notify })
          : null,
        tab === 'consolidate'
          ? h(ConsolidationPanel, { api, lang, boot, notify, onChanged: refreshBoot })
          : null,
        tab === 'maintenance'
          ? h(MaintenancePanel, { api, lang, boot, notify, onChanged: refreshBoot })
          : null,
      )
    }

    // -------------------------------------------------------- 记忆 / 记事 ----

    function ItemBrowser({ api, lang, settings, kind, notify, onChanged }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const isNote = kind === 'note'
      const [query, setQuery] = useState('')
      const [appliedQuery, setAppliedQuery] = useState('')
      const [layer, setLayer] = useState('')
      const [status, setStatus] = useState('usable')
      const [sort, setSort] = useState('updated')
      const [notebook, setNotebook] = useState('memory')
      const [page, setPage] = useState(0)
      const [result, setResult] = useState({ items: [], total: 0, limit: settings.ui.pageSize })
      const [loading, setLoading] = useState(false)
      const [listError, setListError] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [draft, setDraft] = useState(null)
      const [creating, setCreating] = useState(false)
      const [saving, setSaving] = useState(false)

      const pageSize = settings.ui.pageSize

      const reload = useCallback(async () => {
        setLoading(true)
        try {
          const params = {
            type: kind,
            layer: layer === '' ? undefined : layer,
            status,
            sort,
            limit: pageSize,
            offset: page * pageSize,
          }
          if (isNote) params.notebook = notebook
          const value = appliedQuery === ''
            ? await api('items.list', params)
            : await api('items.search', { ...params, query: appliedQuery })
          setResult(value)
          setListError('')
        } catch (error) {
          setListError(error.message)
        } finally {
          setLoading(false)
        }
      }, [api, kind, isNote, layer, status, sort, page, pageSize, appliedQuery, notebook])

      useEffect(() => {
        reload()
      }, [reload])

      const current = useMemo(() => {
        if (selectedId === null) return null
        return result.items.find((item) => item.id === selectedId) ?? null
      }, [result.items, selectedId])

      useEffect(() => {
        if (current !== null) {
          setDraft(toDraft(current))
          setCreating(false)
        }
      }, [current?.id])

      function startCreate() {
        setSelectedId(null)
        setCreating(true)
        setDraft({
          title: '',
          content: '',
          tags: '',
          importance: settings.write.defaultImportance,
          layer: settings.write.defaultLayer,
          notebook,
          ttlDays: kind === 'note' ? '' : String(settings.write.defaultTtlDays ?? 30),
          pinned: false,
          status: 'active',
        })
      }

      function openItem(item) {
        setSelectedId(item.id)
        setCreating(false)
        setDraft(toDraft(item))
      }

      async function save() {
        if (draft === null) return
        setSaving(true)
        try {
          const payload = fromDraft(draft, kind, notebook)
          if (creating) {
            const value = await api('items.create', payload)
            notify(txt(`已新建：${value.item.title}`, `Created: ${value.item.title}`))
            setCreating(false)
            setSelectedId(value.item.id)
            setDraft(toDraft(value.item))
          } else if (selectedId !== null) {
            const value = await api('items.update', { id: selectedId, patch: payload })
            notify(txt('已保存', 'Saved'))
            setDraft(toDraft(value.item))
          }
          await reload()
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setSaving(false)
        }
      }

      async function remove() {
        if (selectedId === null) return
        if (settings.ui.confirmDelete && typeof window !== 'undefined'
          && !window.confirm(txt('确定删除这条记忆吗？此操作不可撤销。', 'Delete this entry? This cannot be undone.'))) return
        try {
          await api('items.delete', { ids: [selectedId] })
          notify(txt('已删除', 'Deleted'))
          setSelectedId(null)
          setDraft(null)
          await reload()
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      async function bulk(action, ids) {
        try {
          const value = await api('items.bulk', { ids, action })
          notify(txt(`已处理 ${value.changed ?? value.deleted ?? 0} 条`, `Updated ${value.changed ?? value.deleted ?? 0} item(s)`))
          await reload()
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      const totalPages = Math.max(1, Math.ceil((result.total ?? 0) / pageSize))

      return h('div', { className: 'mp-panel' },
        h('div', { className: 'mp-toolbar' },
          h('input', {
            className: 'mp-input is-grow',
            placeholder: txt('搜索标题、正文或标签，回车检索', 'Search title, body or tags, press Enter'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                setPage(0)
                setAppliedQuery(query.trim())
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'mp-btn',
            onClick: () => {
              setPage(0)
              setAppliedQuery(query.trim())
            },
          }, txt('搜索', 'Search')),
          appliedQuery === '' ? null : h('button', {
            type: 'button',
            className: 'mp-btn is-ghost',
            onClick: () => {
              setQuery('')
              setAppliedQuery('')
              setPage(0)
            },
          }, txt('清除', 'Clear')),
          h('select', {
            className: 'mp-select',
            value: layer,
            onChange: (event) => {
              setPage(0)
              setLayer(event.target.value)
            },
          }, h('option', { value: '' }, txt('全部分层', 'All layers')),
            (boot_layers).map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.id} ${labelOf(entry.name)}`))),
          h('select', {
            className: 'mp-select',
            value: status,
            onChange: (event) => {
              setPage(0)
              setStatus(event.target.value)
            },
          },
            h('option', { value: 'usable' }, txt('可用', 'Usable')),
            h('option', { value: 'active' }, txt('仅活跃', 'Active only')),
            h('option', { value: 'archived' }, txt('已归档', 'Archived')),
            h('option', { value: 'expired' }, txt('已过期', 'Expired')),
            h('option', { value: 'conflicted' }, txt('冲突', 'Conflicted')),
            h('option', { value: 'all' }, txt('全部状态', 'All statuses'))),
          h('select', {
            className: 'mp-select',
            value: sort,
            onChange: (event) => setSort(event.target.value),
          }, (sortChoices).map((entry) => h('option', { key: entry.value, value: entry.value }, labelOf(entry.label)))),
          h('button', { type: 'button', className: 'mp-btn is-primary', onClick: startCreate },
            isNote ? txt('新建记事', 'New note') : txt('新建记忆', 'New memory'))),
        isNote
          ? h('div', { className: 'mp-toolbar' }, NOTEBOOK_FALLBACK.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            className: `mp-btn${notebook === entry.id ? ' is-primary' : ''}`,
            onClick: () => {
              setNotebook(entry.id)
              setPage(0)
            },
          }, labelOf(entry.name))))
          : null,
        listError === '' ? null : h('div', { className: 'mp-toast is-error' }, listError),
        h('div', { className: 'mp-split' },
          h('div', { className: 'mp-list' },
            loading && result.items.length === 0
              ? h('div', { className: 'mp-empty' }, txt('加载中…', 'Loading…'))
              : result.items.length === 0
                ? h('div', { className: 'mp-empty' },
                  appliedQuery === ''
                    ? (isNote ? txt('还没有记事。', 'No notes yet.') : txt('还没有记忆。让模型记点什么，或点右上角新建。', 'No memories yet. Ask the model to remember something, or create one above.'))
                    : txt('没有匹配的条目。', 'Nothing matched.'))
                : result.items.map((item) => h('div', {
                  key: item.id,
                  className: `mp-row${item.id === selectedId ? ' is-active' : ''}`,
                  onClick: () => openItem(item),
                },
                  h('div', { className: 'mp-row-title' },
                    h('span', null, item.title),
                    h(StatusChip, { lang, item })),
                  h('div', { className: 'mp-row-body' }, String(item.content).slice(0, 120)),
                  h('div', { className: 'mp-row-meta' },
                    settings.ui.showLayerBadges ? h(LayerBadge, { item }) : null,
                    h('span', null, `${txt('重要度', 'importance')} ${item.importance}`),
                    typeof item.score === 'number' ? h('span', null, `${txt('得分', 'score')} ${item.score}`) : null,
                    h('span', null, formatTime(item.updatedAt))))),
            result.total > pageSize
              ? h('div', { className: 'mp-pager', style: { padding: '8px 10px' } },
                h('button', {
                  type: 'button',
                  className: 'mp-btn',
                  disabled: page === 0,
                  onClick: () => setPage((value) => Math.max(0, value - 1)),
                }, txt('上一页', 'Prev')),
                `${page + 1} / ${totalPages}`,
                h('button', {
                  type: 'button',
                  className: 'mp-btn',
                  disabled: page + 1 >= totalPages,
                  onClick: () => setPage((value) => value + 1),
                }, txt('下一页', 'Next')))
              : null),
          draft === null
            ? h('div', { className: 'mp-editor' },
              h('div', { className: 'mp-empty' },
                txt('从左侧选择一条，或点“新建”开始。', 'Pick an entry on the left, or use the new button.')))
            : h(ItemEditor, {
              lang,
              draft,
              setDraft,
              creating,
              saving,
              isNote,
              settings,
              onSave: save,
              onDelete: remove,
              onBulk: (action) => bulk(action, creating ? [] : [selectedId]),
              onClose: () => {
                setDraft(null)
                setSelectedId(null)
                setCreating(false)
              },
            })),
      )
    }

    function toDraft(item) {
      return {
        title: item.title ?? '',
        content: item.content ?? '',
        tags: (item.tags ?? []).join(', '),
        importance: item.importance ?? 5,
        layer: item.layer ?? 'L5',
        notebook: item.notebook ?? 'memory',
        ttlDays: item.ttlDays === null || item.ttlDays === undefined ? '' : String(item.ttlDays),
        pinned: item.pinned === true,
        status: item.status ?? 'active',
      }
    }

    function fromDraft(draft, kind, notebook) {
      const ttlText = String(draft.ttlDays ?? '').trim()
      const payload = {
        type: kind,
        title: String(draft.title ?? ''),
        content: String(draft.content ?? ''),
        tags: String(draft.tags ?? '').split(/[,，;；\s]+/).map((tag) => tag.trim()).filter((tag) => tag !== ''),
        importance: Number(draft.importance) || 5,
        layer: String(draft.layer ?? 'L5'),
        pinned: draft.pinned === true,
      }
      if (kind === 'note') payload.notebook = draft.notebook ?? notebook
      if (ttlText !== '') payload.ttlDays = Number(ttlText)
      // 新建只给 active；已有条目的状态改动在编辑区显式提交。
      if (draft.status !== undefined) payload.status = draft.status
      return payload
    }

    function ItemEditor({ lang, draft, setDraft, creating, saving, isNote, settings, onSave, onDelete, onBulk, onClose }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const update = (key, value) => setDraft({ ...draft, [key]: value })
      const immutable = ['L0', 'L1', 'L3'].includes(draft.layer)
      const readOnly = immutable && !settings.write.allowImmutableEdit
      const ttlRequired = isNote !== true && immutable !== true
      const ttlMissing = ttlRequired && String(draft.ttlDays ?? '').trim() === ''

      return h('div', { className: 'mp-editor' },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
          h('div', { className: 'mp-card-title', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            creating
              ? (isNote ? txt('新建记事', 'New note') : txt('新建记忆', 'New memory'))
              : txt('编辑条目', 'Edit entry'),
            h(LayerBadge, { item: draft, large: true })),
          h('button', { type: 'button', className: 'mp-btn is-ghost', onClick: onClose }, txt('关闭', 'Close'))),
        readOnly
          ? h('div', { className: 'mp-toast' }, txt(
            `${draft.layer} 是不可变层，默认只读。需要修改请在设置里打开“允许改写不可变层”。`,
            `${draft.layer} is immutable and read-only. Enable immutable edits in settings to change it.`))
          : null,
        h('label', { className: 'mp-field' },
          h('span', { className: 'mp-label' }, txt('标题', 'Title')),
          h('input', {
            className: 'mp-input',
            value: draft.title,
            disabled: readOnly,
            onChange: (event) => update('title', event.target.value),
          })),
        h('label', { className: 'mp-field' },
          h('span', { className: 'mp-label' }, txt('正文', 'Content')),
          h('textarea', {
            className: 'mp-textarea',
            rows: 9,
            value: draft.content,
            disabled: readOnly,
            onChange: (event) => update('content', event.target.value),
          })),
        h('label', { className: 'mp-field' },
          h('span', { className: 'mp-label' }, txt('标签', 'Tags')),
          h('input', {
            className: 'mp-input',
            value: draft.tags,
            placeholder: txt('用逗号分隔，例如：构建, 偏好', 'Comma separated, e.g. build, preference'),
            onChange: (event) => update('tags', event.target.value),
          })),
        h('div', { className: 'mp-grid2' },
          h('label', { className: 'mp-field' },
            h('span', { className: 'mp-label' }, txt('分层', 'Layer')),
            h('select', {
              className: 'mp-select',
              value: draft.layer,
              disabled: readOnly,
              onChange: (event) => update('layer', event.target.value),
            }, LAYER_FALLBACK.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.id} ${labelOf(entry.name)}`)))),
          h('label', { className: 'mp-field' },
            h('span', { className: 'mp-label' }, txt('重要度', 'Importance')),
            h('input', {
              className: 'mp-input',
              type: 'number',
              min: 1,
              max: 10,
              value: draft.importance,
              disabled: readOnly,
              onChange: (event) => update('importance', Number(event.target.value)),
            })),
          isNote
            ? h('label', { className: 'mp-field' },
              h('span', { className: 'mp-label' }, txt('记事本', 'Notebook')),
              h('select', {
                className: 'mp-select',
                value: draft.notebook,
                onChange: (event) => update('notebook', event.target.value),
              }, NOTEBOOK_FALLBACK.map((entry) => h('option', { key: entry.id, value: entry.id }, labelOf(entry.name)))))
            : null,
          h('label', { className: 'mp-field' },
            h('span', { className: 'mp-label' }, ttlRequired
              ? txt('保鲜期（天）*', 'TTL (days) *')
              : txt('保鲜期（天）', 'TTL (days)')),
            h('input', {
              className: 'mp-input',
              type: 'number',
              min: 1,
              placeholder: ttlRequired
                ? txt('必填，例如 30', 'Required, e.g. 30')
                : txt('不可变层无需填写', 'Not needed for immutable layers'),
              value: draft.ttlDays,
              disabled: readOnly,
              onChange: (event) => update('ttlDays', event.target.value),
            }),
            ttlRequired
              ? h('span', { className: 'mp-hint' }, txt(
                '可修改层的记忆必须填写保鲜期；修改内容时会从当前时间重新计算到期日。',
                'Mutable memories must carry a freshness period; editing content restarts the expiry clock.'))
              : null,
            ttlMissing
              ? h('span', { className: 'mp-ttl-alert' }, txt(
                '缺少保鲜期：保存会被拒绝，请填写天数。',
                'Missing freshness period: saving is blocked until you enter a number of days.'))
              : null),
          h('label', { className: 'mp-field' },
            h('span', { className: 'mp-label' }, txt('状态', 'Status')),
            h('select', {
              className: 'mp-select',
              value: draft.status,
              disabled: readOnly,
              onChange: (event) => update('status', event.target.value),
            },
              h('option', { value: 'active' }, txt('活跃', 'Active')),
              h('option', { value: 'archived' }, txt('已归档', 'Archived')),
              h('option', { value: 'conflicted' }, txt('冲突', 'Conflicted')),
              h('option', { value: 'expired' }, txt('已过期', 'Expired')))),
          h('label', { className: 'mp-field' },
            h('span', { className: 'mp-label' }, txt('置顶', 'Pinned')),
            h('span', { className: 'mp-switch' },
              h('input', {
                type: 'checkbox',
                checked: draft.pinned === true,
                disabled: readOnly,
                onChange: (event) => update('pinned', event.target.checked),
              }),
              h('span', null, txt('自动维护时跳过', 'Skip automatic maintenance'))))),
        h('div', { className: 'mp-toolbar' },
          h('button', {
            type: 'button',
            className: 'mp-btn is-primary',
            disabled: saving || readOnly || ttlMissing,
            onClick: onSave,
          }, saving ? txt('保存中…', 'Saving…') : txt('保存', 'Save')),
          creating
            ? null
            : h('button', { type: 'button', className: 'mp-btn', disabled: readOnly, onClick: () => onBulk('promote') },
              txt('提升重要度', 'Promote')),
          creating
            ? null
            : h('button', {
              type: 'button',
              className: 'mp-btn',
              disabled: readOnly,
              onClick: () => onBulk(draft.status === 'archived' ? 'restore' : 'archive'),
            }, draft.status === 'archived' ? txt('恢复', 'Restore') : txt('归档', 'Archive')),
          creating
            ? null
            : h('button', { type: 'button', className: 'mp-btn is-danger', disabled: readOnly, onClick: onDelete },
              txt('删除', 'Delete'))))
    }

    // ------------------------------------------------------------ 用量页 ----

    function UsagePanel({ api, lang, notify }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const [type, setType] = useState('note')
      const [stats, setStats] = useState(null)
      const [loading, setLoading] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const value = await api('usage.stats', type === 'all' ? {} : { type })
          setStats(value)
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setLoading(false)
        }
      }, [api, type, notify])

      useEffect(() => {
        load()
      }, [load])

      const recent = stats?.recent ?? []
      const byType = stats?.byType ?? {}
      return h('div', { className: 'mp-panel' },
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-inject-head' },
            h('div', null,
              h('div', { className: 'mp-card-title' }, txt('智能体查询消耗的 token', 'Tokens spent by agent queries')),
              h('div', { className: 'mp-hint' }, txt(
                '只统计模型通过 memory_search 等工具发起的查询；结果里含记事本的查询都会计入“记事本”视图，设置页里翻列表不计入。',
                'Only agent calls through memory_search and related tools count; any query whose results include notebook entries counts toward the notebook view. Browsing here is not counted.'))),
            h('div', { className: 'mp-toolbar' },
              h('select', {
                className: 'mp-select',
                value: type,
                onChange: (event) => setType(event.target.value),
              },
                h('option', { value: 'note' }, txt('记事本', 'Notebooks')),
                h('option', { value: 'memory' }, txt('记忆', 'Memories')),
                h('option', { value: 'all' }, txt('全部', 'All'))),
              h('button', { type: 'button', className: 'mp-btn', disabled: loading, onClick: load },
                loading ? txt('刷新中…', 'Refreshing…') : txt('刷新', 'Refresh')))),
          h('div', { className: 'mp-usage-grid' },
            h('div', { className: 'mp-kpi' },
              h('span', { className: 'mp-hint' }, txt('调用次数', 'Calls')),
              h('b', null, stats?.calls ?? 0)),
            h('div', { className: 'mp-kpi' },
              h('span', { className: 'mp-hint' }, txt('查询 token', 'Query tokens')),
              h('b', null, stats?.queryTokens ?? 0)),
            h('div', { className: 'mp-kpi' },
              h('span', { className: 'mp-hint' }, txt('结果 token', 'Result tokens')),
              h('b', null, stats?.resultTokens ?? 0)),
            h('div', { className: 'mp-kpi' },
              h('span', { className: 'mp-hint' }, txt('合计 token', 'Total tokens')),
              h('b', null, stats?.totalTokens ?? 0))),
          h('div', { className: 'mp-hint' }, txt(
            `累计（不过滤）：${stats?.allTime?.calls ?? 0} 次，查询 ${stats?.allTime?.queryTokens ?? 0} + 结果 ${stats?.allTime?.resultTokens ?? 0} token。`,
            `All time (unfiltered): ${stats?.allTime?.calls ?? 0} calls, ${stats?.allTime?.queryTokens ?? 0} query + ${stats?.allTime?.resultTokens ?? 0} result tokens.`))),
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-card-title' }, txt('当前筛选下的类型 / 工具', 'Type / tool for this filter')),
          h('div', { className: 'mp-layer-table' },
            Object.entries(byType).map(([key, bucket]) => h('div', { key, style: { display: 'contents' } },
              h('span', null, key === 'all' ? txt('未指定类型', 'unspecified') : key),
              h('span', { style: { textAlign: 'right' } }, `${bucket.queryTokens + bucket.resultTokens} token`),
              h('span', { className: 'mp-hint' }, `${bucket.calls} 次`))),
            Object.entries(stats?.byTool ?? {}).map(([key, bucket]) => h('div', { key, style: { display: 'contents' } },
              h('span', null, key),
              h('span', { style: { textAlign: 'right' } }, `${bucket.queryTokens + bucket.resultTokens} token`),
              h('span', { className: 'mp-hint' }, `${bucket.calls} 次`))))),
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-card-title' }, txt('最近查询', 'Recent queries')),
          recent.length === 0
            ? h('div', { className: 'mp-empty' }, txt('当前筛选下还没有记录。', 'No usage recorded for this filter.'))
            : h('div', { className: 'mp-list-plain' }, recent.map((entry, index) => h('div', {
              key: `${entry.at}-${index}`,
              className: 'mp-audit',
              style: { flexDirection: 'column', gap: '2px' },
            },
              h('div', null, `${formatTime(entry.at)} · ${entry.tool} · ${entry.type}`),
              h('div', null, `${txt('查询', 'query')} ${entry.queryTokens} + ${txt('结果', 'result')} ${entry.resultTokens} token · ${entry.results} 条`),
              entry.query === '' ? null : h('div', { className: 'mp-code' }, entry.query))))))
    }

    // ------------------------------------------------------------ 固化页 ----

    function ConsolidationPanel({ api, lang, boot, notify, onChanged }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const [candidates, setCandidates] = useState(boot.consolidation?.candidates ?? [])
      const [loading, setLoading] = useState(false)
      const settings = boot.settings?.consolidation ?? {}

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const value = await api('consolidation.candidates', {})
          setCandidates(value.candidates ?? [])
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setLoading(false)
        }
      }, [api, notify])

      async function scan() {
        setLoading(true)
        try {
          await api('maintenance.run', { tasks: ['consolidate'] })
          notify(txt('已扫描强化信号', 'Scanned reinforcement signals'))
          await load()
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setLoading(false)
        }
      }

      async function decide(candidate, decision) {
        let note = ''
        if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
          note = window.prompt(txt(
            `审计意见（${decision === 'approve' ? '同意固化' : '拒绝固化'}，可留空）：`,
            `Audit note (${decision}, optional):`), '') ?? ''
        }
        setLoading(true)
        try {
          await api('consolidation.apply', {
            id: candidate.id,
            decision,
            note,
            targetLayer: candidate.suggestedLayer,
            ttlDays: candidate.suggestedTtlDays,
          })
          notify(decision === 'approve'
            ? txt('已固化并写入审计', 'Consolidated and audited')
            : txt('已记录拒绝理由', 'Rejection recorded'))
          await load()
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setLoading(false)
        }
      }

      return h('div', { className: 'mp-panel' },
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-inject-head' },
            h('div', null,
              h('div', { className: 'mp-card-title' }, txt('固化审计', 'Consolidation audit')),
              h('div', { className: 'mp-hint' }, txt(
                `窗口 ${settings.windowDays ?? 14} 天内写入/更新/命中达到 ${settings.threshold ?? 4} 次的记忆会成为候选；智能体或你确认后才提升到 ${settings.targetLayer ?? 'L4'}，并写入审计日志。`,
                `Memories with ${settings.threshold ?? 4} writes/updates/hits within ${settings.windowDays ?? 14} days become candidates; only an explicit approval moves them to ${settings.targetLayer ?? 'L4'}, with an audit record.`))),
            h('button', { type: 'button', className: 'mp-btn', disabled: loading, onClick: scan },
              loading ? txt('扫描中…', 'Scanning…') : txt('扫描强化信号', 'Scan signals'))),
          candidates.length === 0
            ? h('div', { className: 'mp-empty' }, txt(
              '没有待审计候选。反复出现的记忆会在这里出现；也可以先跑“扫描强化信号”。',
              'No candidates waiting. Repeated memories will show up here; run “Scan signals” to refresh.'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              candidates.map((candidate) => h('div', { key: candidate.id, className: 'mp-consolidate-row' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                  h(LayerBadge, { item: candidate }),
                  h('strong', null, candidate.title),
                  h('span', { className: 'mp-chip' }, `${candidate.signals} 次信号`),
                  h('span', { className: 'mp-hint' }, `${candidate.windowDays} 天`)),
                h('div', { className: 'mp-hint' }, txt(
                  `写入 ${candidate.breakdown?.create ?? 0} · 更新 ${candidate.breakdown?.update ?? 0} · 命中 ${candidate.breakdown?.hit ?? 0}；建议 → ${candidate.suggestedLayer}，保鲜 ${candidate.suggestedTtlDays} 天`,
                  `create ${candidate.breakdown?.create ?? 0} · update ${candidate.breakdown?.update ?? 0} · hit ${candidate.breakdown?.hit ?? 0}; suggested ${candidate.suggestedLayer}, TTL ${candidate.suggestedTtlDays} days`)),
                h('div', { className: 'mp-toolbar' },
                  h('button', { type: 'button', className: 'mp-btn is-primary', disabled: loading, onClick: () => decide(candidate, 'approve') },
                    txt('审计通过并固化', 'Approve & consolidate')),
                  h('button', { type: 'button', className: 'mp-btn is-danger', disabled: loading, onClick: () => decide(candidate, 'reject') },
                    txt('拒绝', 'Reject'))))))),
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-card-title' }, txt('规则', 'Rules')),
          h('div', { className: 'mp-hint' }, txt(
            `自动应用：${settings.autoApply === true ? '开启（维护任务会直接固化）' : '关闭（必须逐条审计）'} · 最低重要度 ${settings.minImportance ?? 6} · 单轮最多 ${settings.maxCandidates ?? 20} 条。`,
            `Auto-apply: ${settings.autoApply === true ? 'on (maintenance consolidates directly)' : 'off (every candidate needs an audit)'} · min importance ${settings.minImportance ?? 6} · max ${settings.maxCandidates ?? 20} per scan.`)),
          h('div', { className: 'mp-hint' }, txt(
            '固化动作会记录在维护页的审计日志里（consolidation.proposed / approved / rejected），包含时间、操作者、层级变化和保鲜期。',
            'Decisions are recorded in the audit log (consolidation.proposed / approved / rejected) with time, actor, layer change and TTL.')))
      )
    }

    // ------------------------------------------------------------ 设置页 ----

    function SettingsPanel({ api, lang, boot, notify, onSaved }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const [draft, setDraft] = useState(() => cloneJson(boot.settings))
      const [saving, setSaving] = useState(false)
      const [collapsed, setCollapsed] = useState({})

      useEffect(() => {
        setDraft(cloneJson(boot.settings))
      }, [boot.settings])

      const schema = boot.schema ?? []

      async function save() {
        setSaving(true)
        try {
          const patch = cloneJson(draft)
          delete patch.storage?.__note
          const value = await api('settings.save', { patch })
          notify(txt('设置已保存', 'Settings saved'))
          await onSaved()
          setDraft(cloneJson(value.settings))
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setSaving(false)
        }
      }

      async function reset() {
        if (typeof window !== 'undefined' && !window.confirm(txt(
          '恢复全部设置为默认值？（记忆数据不受影响）',
          'Reset every setting to its default? (Memory data is untouched)'))) return
        try {
          const value = await api('settings.reset', {})
          notify(txt('已恢复默认设置', 'Settings reset'))
          setDraft(cloneJson(value.settings))
          await onSaved()
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      return h('div', { className: 'mp-panel' },
        h('div', { className: 'mp-toolbar', style: { justifyContent: 'space-between' } },
          h('div', { className: 'mp-sub' }, txt('所有设置保存在记忆库文件里，随数据一起备份。', 'All settings live in the memory store file and are backed up with it.')),
          h('div', { className: 'mp-toolbar' },
            h('button', { type: 'button', className: 'mp-btn', onClick: reset }, txt('恢复默认', 'Reset defaults')),
            h('button', { type: 'button', className: 'mp-btn is-primary', disabled: saving, onClick: save },
              saving ? txt('保存中…', 'Saving…') : txt('保存设置', 'Save settings')))),
        schema.map((group) => {
          const folded = collapsed[group.id] === true
          return h('div', { key: group.id, className: 'mp-card' },
            h('div', {
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' },
              onClick: () => setCollapsed({ ...collapsed, [group.id]: !folded }),
            },
              h('div', null,
                h('div', { className: 'mp-card-title' }, labelOf(group.title)),
                group.desc === undefined ? null : h('div', { className: 'mp-hint' }, labelOf(group.desc))),
              h('span', { className: 'mp-chip' }, folded ? '＋' : '－')),
            folded ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              (group.fields ?? []).map((field) => h(FieldControl, {
                key: field.path,
                field,
                lang,
                value: getPath(draft, field.path),
                onChange: (next) => setDraft((previous) => setPath(cloneJson(previous), field.path, next)),
              }))))
        }),
        h('div', { className: 'mp-toolbar', style: { justifyContent: 'flex-end' } },
          h('button', { type: 'button', className: 'mp-btn is-primary', disabled: saving, onClick: save },
            saving ? txt('保存中…', 'Saving…') : txt('保存设置', 'Save settings'))))
    }

    function FieldControl({ field, lang, value, onChange }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const label = typeof field.label === 'string' ? field.label : labelOf(field.label)
      const hint = field.hint === undefined ? '' : labelOf(field.hint)
      const unit = field.unit === undefined ? '' : labelOf(field.unit)

      if (field.type === 'boolean') {
        return h('label', { className: 'mp-field' },
          h('span', { className: 'mp-switch' },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              onChange: (event) => onChange(event.target.checked),
            }),
            h('span', { className: 'mp-layer-name' }, label)),
          hint === '' ? null : h('span', { className: 'mp-hint' }, hint))
      }

      if (field.type === 'select') {
        return h('label', { className: 'mp-field' },
          h('span', { className: 'mp-label' }, label),
          h('select', {
            className: 'mp-select',
            value: value ?? '',
            onChange: (event) => onChange(event.target.value),
          }, (field.options ?? []).map((option) => h('option', { key: option.value, value: option.value }, labelOf(option.label)))),
          hint === '' ? null : h('span', { className: 'mp-hint' }, hint))
      }

      if (field.type === 'number') {
        return h('label', { className: 'mp-field' },
          h('span', { className: 'mp-label' }, label),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('input', {
              className: 'mp-input',
              type: 'number',
              min: field.min,
              max: field.max,
              step: field.step,
              value: value ?? '',
              onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value)),
              style: { width: '130px' },
            }),
            unit === '' ? null : h('span', { className: 'mp-hint' }, unit)),
          hint === '' ? null : h('span', { className: 'mp-hint' }, hint))
      }

      if (field.type === 'textarea') {
        return h('label', { className: 'mp-field' },
          h('span', { className: 'mp-label' }, label),
          h('textarea', {
            className: 'mp-textarea',
            rows: 3,
            value: value ?? '',
            onChange: (event) => onChange(event.target.value),
          }),
          hint === '' ? null : h('span', { className: 'mp-hint' }, hint))
      }

      return h('label', { className: 'mp-field' },
        h('span', { className: 'mp-label' }, label),
        h('input', {
          className: 'mp-input',
          value: value ?? '',
          placeholder: field.placeholder === undefined ? '' : labelOf(field.placeholder),
          onChange: (event) => onChange(event.target.value),
        }),
        hint === '' ? null : h('span', { className: 'mp-hint' }, hint))
    }

    // ------------------------------------------------------------ 维护页 ----

    function MaintenancePanel({ api, lang, boot, notify, onChanged }) {
      const txt = (zh, en) => (lang === 'zh' ? zh : en)
      const [report, setReport] = useState(null)
      const [running, setRunning] = useState(false)
      const [prompt, setPrompt] = useState(null)
      const [audit, setAudit] = useState([])
      const [importText, setImportText] = useState('')
      const [importMode, setImportMode] = useState('merge')

      const loadAudit = useCallback(async () => {
        try {
          const value = await api('audit.list', { limit: 30 })
          setAudit(value.audit ?? [])
        } catch (error) {
          notify(error.message, 'error')
        }
      }, [api, notify])

      useEffect(() => {
        loadAudit()
      }, [loadAudit])

      async function run(tasks) {
        setRunning(true)
        try {
          const value = await api('maintenance.run', { tasks })
          setReport(value)
          notify(txt('维护完成', 'Maintenance finished'))
          await loadAudit()
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setRunning(false)
        }
      }

      async function previewPrompt() {
        try {
          const value = await api('prompt.preview', {})
          setPrompt(value)
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      async function exportData() {
        try {
          const value = await api('data.export', {})
          const text = JSON.stringify(value.export, null, 2)
          if (typeof document !== 'undefined') {
            const blob = new Blob([text], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = `dsh-memory-${new Date().toISOString().slice(0, 10)}.json`
            anchor.click()
            setTimeout(() => URL.revokeObjectURL(url), 2000)
          }
          notify(txt('已导出 JSON', 'Exported JSON'))
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      async function backupNow() {
        try {
          const value = await api('backups.create', { tag: 'manual' })
          const name = value.backup?.name ?? value.backup?.path ?? ''
          notify(txt(`已备份：${name}`, `Backed up: ${name}`))
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      async function rebuildIndexes() {
        try {
          const value = await api('indexes.rebuild', {})
          notify(txt(`索引已重建（${value.items ?? 0} 条）`, `Indexes rebuilt (${value.items ?? 0} items)`))
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      async function importData() {
        let parsed
        try {
          parsed = JSON.parse(importText)
        } catch {
          notify(txt('粘贴的内容不是合法 JSON', 'That is not valid JSON'), 'error')
          return
        }
        try {
          const value = await api('data.import', { data: parsed, mode: importMode })
          notify(txt(`导入 ${value.imported} 条（跳过 ${value.skipped}）`, `Imported ${value.imported} (skipped ${value.skipped})`))
          setImportText('')
          await loadAudit()
          await onChanged()
        } catch (error) {
          notify(error.message, 'error')
        }
      }

      const storage = boot.storage ?? {}
      const tasks = [
        { id: ['rotate'], label: txt('轮转清理', 'Rotate'), desc: txt('按重要性评分清理 L6/L7 低分条目（Go 服务批量评分）', 'Expire low-importance L6/L7 entries by importance score') },
        { id: ['cleanup'], label: txt('过期清理', 'Expire stale'), desc: txt('把超过保鲜期的条目标记为已过期', 'Mark entries past their TTL as expired') },
        { id: ['archive'], label: txt('归档', 'Archive'), desc: txt(`长期未更新且重要度≤4 的条目归档（>${boot.settings.maintenance.archiveAfterDays} 天）`, `Archive stale low-importance entries (>${boot.settings.maintenance.archiveAfterDays} days)`) },
        { id: ['dedupe'], label: txt('重复检测', 'Detect duplicates'), desc: txt('找出高度相似的条目并互相标记冲突', 'Mark near-duplicate entries as conflicts') },
        { id: ['reflect'], label: txt('反思提升', 'Reflect'), desc: txt('被反复检索到的记忆自动/建议提升重要度', 'Raise importance of memories retrieved repeatedly') },
        { id: ['consolidate'], label: txt('固化扫描', 'Consolidate'), desc: txt('扫描反复写入/更新/命中的记忆，生成待审计候选', 'Find repeatedly reinforced memories and queue them for audit') },
        { id: ['compact'], label: txt('压缩日志', 'Compact log'), desc: txt('按上限裁剪审计日志', 'Trim the audit log to the configured cap') },
      ]

      return h('div', { className: 'mp-panel' },
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-card-title' }, txt('维护任务', 'Maintenance')),
          h('div', { className: 'mp-hint' }, txt(
            '插件会按设置的间隔自动运行这些任务；也可以立刻手动跑一次。',
            'These run automatically on the configured interval; you can also run them now.')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            tasks.map((task) => h('div', {
              key: task.id[0],
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
            },
              h('div', null,
                h('div', { className: 'mp-layer-name' }, task.label),
                h('div', { className: 'mp-layer-desc' }, task.desc)),
              h('button', {
                type: 'button',
                className: 'mp-btn',
                disabled: running,
                onClick: () => run(task.id),
              }, txt('运行', 'Run'))))),
          h('div', { className: 'mp-toolbar' },
            h('button', {
              type: 'button',
              className: 'mp-btn is-primary',
              disabled: running,
              onClick: () => run(['limits', 'cleanup', 'rotate', 'archive', 'dedupe', 'reflect', 'consolidate', 'compact']),
            }, running ? txt('运行中…', 'Running…') : txt('全部运行', 'Run all')),
            h('button', { type: 'button', className: 'mp-btn', onClick: previewPrompt },
              txt('预览提示词注入', 'Preview prompt injection'))),
          report === null ? null : h('div', { className: 'mp-card', style: { background: 'var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04))' } },
            h('div', { className: 'mp-hint' }, `${txt('运行时间', 'ran at')} ${formatTime(report.ranAt)}`),
            (report.tasks ?? []).map((task) => h('div', { key: task.task, className: 'mp-hint' },
              `• ${task.task}：${task.note}`)),
            report.totals === undefined ? null : h('div', { className: 'mp-hint' },
              `${txt('当前总计', 'total')} ${report.totals.total ?? 0}`)),
          prompt === null ? null : h('label', { className: 'mp-field' },
            h('span', { className: 'mp-label' }, txt('注入到系统提示词的文本', 'Text injected into the system prompt')),
            h('textarea', {
              className: 'mp-textarea',
              rows: 8,
              readOnly: true,
              value: prompt.text === '' ? txt('（当前没有注入内容：插件关闭、注入关闭或没有可用记忆）', '(Nothing is injected: disabled, injection off, or no usable memories)') : prompt.text,
            }))),
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-card-title' }, txt('存储', 'Storage')),
          h('div', { className: 'mp-code' }, storage.path ?? ''),
          h('div', { className: 'mp-hint' },
            `${txt('引擎', 'engine')} ${storage.engine === 'go'
              ? 'Go 服务 (SQLite + FTS5)'
              : storage.engine === 'sqlite' ? 'Node SQLite（回退）' : 'JSON'}`),
          storage.service === undefined || storage.service === null
            ? null
            : h('div', { className: 'mp-hint' },
              `Go 服务 pid ${storage.service.pid ?? '-'} · port ${storage.service.port ?? '-'} · v${storage.service.version ?? '-'}`),
          h('div', { className: 'mp-hint' },
            (storage.tables === undefined || storage.tables === null
              ? ''
              : `memories ${storage.tables.memories} · events ${storage.tables.events} · assets ${storage.tables.assets} · vectors ${storage.tables.vectors ?? 0} · changelog ${storage.tables.changelog}`)
            + (boot.native === undefined || boot.native === null
              ? ''
              : ` · ${txt('原生核心', 'native core')} ${boot.native.available === true ? `v${boot.native.version ?? ''}` : 'JS 兜底'}`)),
          h('div', { className: 'mp-hint' },
            `${txt('文件', 'file')} ${storage.exists === true ? txt('存在', 'exists') : txt('尚未创建', 'not created yet')} · ${formatBytes(storage.bytes)} · ${storage.modifiedAt === null ? '' : formatTime(storage.modifiedAt)}`),
          h('div', { className: 'mp-toolbar' },
            h('button', { type: 'button', className: 'mp-btn', onClick: exportData }, txt('导出 JSON', 'Export JSON')),
            h('button', { type: 'button', className: 'mp-btn', onClick: backupNow }, txt('立即备份', 'Back up now')),
            h('button', { type: 'button', className: 'mp-btn', onClick: rebuildIndexes }, txt('重建索引', 'Rebuild index')),
            h('button', { type: 'button', className: 'mp-btn', onClick: loadAudit }, txt('刷新审计日志', 'Refresh audit'))),
          h('div', { className: 'mp-list-plain' },
            audit.length === 0
              ? h('div', { className: 'mp-hint' }, txt('审计日志为空。', 'The audit log is empty.'))
              : audit.map((entry, index) => h('div', { key: `${entry.at}-${index}`, className: 'mp-audit' },
                h('span', null, formatTime(entry.at)),
                h('span', null, entry.action),
                h('span', null, entry.detail))))),
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-card-title' }, txt('导入', 'Import')),
          h('div', { className: 'mp-hint' }, txt(
            '粘贴此前导出的 JSON。合并会保留现有条目；替换会清空与导出不重叠的条目（不可变层除外）。',
            'Paste a previously exported JSON. Merge keeps existing entries; replace drops entries not in the file (immutable layers are kept).')),
          h('textarea', {
            className: 'mp-textarea',
            rows: 5,
            placeholder: '{"format":"dsh-memory-plugin", …}',
            value: importText,
            onChange: (event) => setImportText(event.target.value),
          }),
          h('div', { className: 'mp-toolbar' },
            h('select', {
              className: 'mp-select',
              value: importMode,
              onChange: (event) => setImportMode(event.target.value),
            },
              h('option', { value: 'merge' }, txt('合并', 'Merge')),
              h('option', { value: 'replace' }, txt('替换', 'Replace'))),
            h('button', { type: 'button', className: 'mp-btn', disabled: importText.trim() === '', onClick: importData },
              txt('导入', 'Import')))),
        h('div', { className: 'mp-card' },
          h('div', { className: 'mp-card-title' }, txt('诊断信息', 'Diagnostics')),
          h('div', { className: 'mp-hint' }, `${txt('版本', 'version')} ${boot.pluginVersion ?? ''} · ${txt('分层', 'layers')} ${(boot.layers ?? []).length}`),
          h('div', { className: 'mp-hint' }, `${txt('工具', 'tools')}：${(boot.toolNames ?? []).join(', ')}`),
          h('div', { className: 'mp-hint' }, `${txt('接口', 'API')}：POST ${API_PATHS[0]}`),
          h('div', { className: 'mp-hint' }, `${txt('上次维护', 'last maintenance')} ${formatTime(boot.stats?.lastMaintenance ?? '') || '—'}`)))
    }

    // ------------------------------------------------------ 静态兜底数据 ----

    // 设置页首屏就需要分层/记事本/排序列表；同时用接口返回值覆盖（见 SettingsPanel）。
    const LAYER_FALLBACK = [
      { id: 'L0', name: { zh: '灵魂层', en: 'Soul' } },
      { id: 'L1', name: { zh: '思想核心', en: 'Core ideas' } },
      { id: 'L2', name: '思想流动' },
      { id: 'L3', name: { zh: '本能行为', en: 'Instincts' } },
      { id: 'L4', name: { zh: '学习行为', en: 'Learned behaviour' } },
      { id: 'L5', name: { zh: '目标记忆', en: 'Goals' } },
      { id: 'L6', name: { zh: '轮转记忆', en: 'Rotating memory' } },
      { id: 'L7', name: { zh: '情境感知', en: 'Session context' } },
    ]
    const NOTEBOOK_FALLBACK = [
      { id: 'memory', name: { zh: '记忆记事本', en: 'Memory notes' } },
      { id: 'daily', name: { zh: '日常记事本', en: 'Daily notes' } },
      { id: 'asset', name: { zh: '资产记事本', en: 'Asset notes' } },
    ]

    const boot_layers = LAYER_FALLBACK
    const sortChoices = [
      { value: 'updated', label: { zh: '最近更新', en: 'Recently updated' } },
      { value: 'created', label: { zh: '最近创建', en: 'Recently created' } },
      { value: 'importance', label: { zh: '重要度', en: 'Importance' } },
      { value: 'title', label: { zh: '标题', en: 'Title' } },
    ]

    // ------------------------------------------------------ 侧边栏整页入口 ----

    // 侧边栏图标与 main 面板共用同一个 id；宿主按下这个 id 切换主区域。
    const PANEL_ID = 'memory'

    // 16×16，跟随 currentColor，active 时保持全不透明。
    function MemoryPanelIcon({ size = 16, active = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        style: { opacity: active ? 1 : 0.78, display: 'block' },
      },
        h('ellipse', { cx: 8, cy: 4.1, rx: 4.7, ry: 2.1, stroke: 'currentColor', strokeWidth: 1.25 }),
        h('path', { d: 'M3.3 4.1v7.7c0 1.16 2.1 2.1 4.7 2.1s4.7-.94 4.7-2.1V4.1', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' }),
        h('path', { d: 'M3.3 7.9c0 1.16 2.1 2.1 4.7 2.1s4.7-.94 4.7-2.1', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' }))
    }

    // main 槽位是一个 overflow:hidden 的主列，必须自己当滚动容器，
    // 否则整页内容会超出但滚不动（与 gokifu 页面踩过的坑相同）。
    function MemoryPage() {
      return h('div', {
        className: 'mp-page',
        style: {
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '24px 28px',
        },
      }, h('div', { style: { width: '100%', maxWidth: '1180px', margin: '0 auto' } },
        h(MemorySettingsPage)))
    }

    // ------------------------------------------------------------ 注册 ----

    function label() {
      const nav = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : ''
      return nav.toLowerCase().startsWith('zh') ? '记忆' : 'Memory'
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        installStyles(ctx)
        try {
          if (typeof ctx.locale?.register === 'function') {
            ctx.effect(() => ctx.locale.register(NS, { zh: { 'nav.label': '记忆' }, en: { 'nav.label': 'Memory' } }), 'memory-plugin:locale')
          }
        } catch {
          /* 没有 locale 服务也不影响 */
        }
        // 主入口：侧边栏一枚图标 + 点击后的整页。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => label(),
        }, MemoryPanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, MemoryPage))
        // 保留设置页入口：从设置也能直接打开同一套面板。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'memory-plugin',
          order: 60,
          label,
        }, MemorySettingsPage))
      },
      // 只为测试/调试暴露，宿主运行时不会用到。
      __internals: {
        MemorySettingsPage, MemoryPage, MemoryPanelIcon, ItemBrowser, ItemEditor, SettingsPanel,
        MaintenancePanel, FieldControl, StatusChip, createApi, apiCandidates, PANEL_ID,
        InjectionCard, UsagePanel, ConsolidationPanel, LayerBadge,
      },
    }
  },
})
