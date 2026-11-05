// Package api 是 Go 服务的 HTTP 层（本地回环 + token 鉴权）。
//
// 设计文档里这一层是 gRPC；这里用本地 HTTP/JSON 替代，原因是 Node 侧不引入
// grpc 依赖（插件安装不额外联网），语义等价、调试更直观。
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"dsh-memory-service/internal/search"
	"dsh-memory-service/internal/store"
)

// Server 聚合存储与检索。
type Server struct {
	store     *store.Store
	search    *search.Engine
	token     string
	version   string
	startedAt time.Time
	shutdown  func()
}

// New 创建 API 服务。
func New(st *store.Store, version string) *Server {
	return &Server{
		store:     st,
		search:    search.New(st.DB()),
		token:     "",
		version:   version,
		startedAt: time.Now(),
	}
}

// SetShutdown 注册关闭回调（/shutdown 触发）。
func (s *Server) SetShutdown(fn func()) { s.shutdown = fn }

// SetToken 设置请求鉴权 token（空表示不校验，仅限回环调试）。
func (s *Server) SetToken(token string) { s.token = token }

// Handler 返回路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/snapshot", s.authorized(s.handleSnapshot))
	mux.HandleFunc("/items/upsert", s.authorized(s.handleUpsert))
	mux.HandleFunc("/items/delete", s.authorized(s.handleDelete))
	mux.HandleFunc("/config", s.authorized(s.handleConfig))
	mux.HandleFunc("/audit/append", s.authorized(s.handleAuditAppend))
	mux.HandleFunc("/audit/replace", s.authorized(s.handleAuditReplace))
	mux.HandleFunc("/search", s.authorized(s.handleSearch))
	mux.HandleFunc("/graph/bfs", s.authorized(s.handleBFS))
	mux.HandleFunc("/stats", s.authorized(s.handleStats))
	mux.HandleFunc("/verify", s.authorized(s.handleVerify))
	mux.HandleFunc("/backup", s.authorized(s.handleBackup))
	mux.HandleFunc("/backups", s.authorized(s.handleBackups))
	mux.HandleFunc("/restore", s.authorized(s.handleRestore))
	mux.HandleFunc("/shutdown", s.authorized(s.handleShutdown))
	return mux
}

func (s *Server) authorized(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.token != "" && r.Header.Get("x-memory-token") != s.token {
			writeError(w, http.StatusForbidden, "forbidden", "token 不匹配")
			return
		}
		next(w, r)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.Stats()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "stats_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"version":       s.version,
		"uptimeSeconds": int64(time.Since(s.startedAt).Seconds()),
		"db":            s.store.Path(),
		"stats":         stats,
	})
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method", "POST only")
		return
	}
	state, err := s.store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "load_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "state": state})
}

func (s *Server) handleUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method", "POST only")
		return
	}
	var payload struct {
		Items []store.Item `json:"items"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	started := time.Now()
	if err := s.store.UpsertItems(payload.Items); err != nil {
		writeError(w, http.StatusInternalServerError, "upsert_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "upserted": len(payload.Items), "tookMs": time.Since(started).Milliseconds(),
	})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method", "POST only")
		return
	}
	var payload struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if err := s.store.DeleteItems(payload.IDs); err != nil {
		writeError(w, http.StatusInternalServerError, "delete_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": len(payload.IDs)})
}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if err := s.store.SetConfig(payload.Key, payload.Value); err != nil {
		writeError(w, http.StatusInternalServerError, "config_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAuditAppend(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Entries []store.AuditEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if err := s.store.AppendAudit(payload.Entries); err != nil {
		writeError(w, http.StatusInternalServerError, "audit_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "appended": len(payload.Entries)})
}

func (s *Server) handleAuditReplace(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Entries []store.AuditEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	if err := s.store.ReplaceAudit(payload.Entries); err != nil {
		writeError(w, http.StatusInternalServerError, "audit_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "replaced": len(payload.Entries)})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method", "POST only")
		return
	}
	var options search.Options
	if err := json.NewDecoder(r.Body).Decode(&options); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	started := time.Now()
	hits, err := s.search.Search(options)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "search_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "hits": hits, "total": len(hits),
		"weights": search.NormalizeWeights(options.Weights),
		"tookMs":  time.Since(started).Milliseconds(),
	})
}

func (s *Server) handleBFS(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Seeds      []string `json:"seeds"`
		Depth      int      `json:"depth"`
		MinWeight  float64  `json:"minWeight"`
		MaxResults int      `json:"maxResults"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	nodes, edges, err := s.search.BFS(payload.Seeds, payload.Depth, payload.MinWeight, payload.MaxResults)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "graph_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "nodes": nodes, "edges": edges})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.Stats()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "stats_failed", err.Error())
		return
	}
	ok, verdict, err := s.store.Verify()
	if err != nil {
		verdict = err.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "stats": stats, "integrity": map[string]any{"ok": ok, "verdict": verdict},
	})
}

func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	ok, verdict, err := s.store.Verify()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "verify_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "integrity": ok, "verdict": verdict})
}

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Tag string `json:"tag"`
	}
	json.NewDecoder(r.Body).Decode(&payload)
	info, err := s.store.Backup(payload.Tag)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "backup_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "backup": info})
}

func (s *Server) handleBackups(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListBackups()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "backups": list})
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", err.Error())
		return
	}
	previous, err := s.store.Restore(payload.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "restore_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "restored": payload.Name, "previousFile": previous})
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	if s.shutdown != nil {
		go func() {
			time.Sleep(100 * time.Millisecond)
			s.shutdown()
		}()
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"ok":false,"error":{"code":"encode","message":%q}}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	w.Write(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"ok": false, "error": map[string]string{"code": code, "message": message},
	})
}


