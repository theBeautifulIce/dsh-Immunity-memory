// Package store 拥有 SQLite 持久化（设计文档 §7.1 / §7.2）。
//
// 表结构与迁移：
//
//	v1 memories / events / assets / relationships / changelog / config
//	v2 items_fts —— FTS5 全文索引（现代纯 Go SQLite 驱动自带 FTS5）
//	v3 memory_vectors —— 语义向量（Float32 BLOB）
//
// 写入是事务化的；FTS 与向量在同一事务里同步更新，保证"检索到的"和"读到的"一致。
package store

import (
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"dsh-memory-service/internal/text"
)

// Source 是条目的来源信息。
type Source struct {
	Kind       string   `json:"kind"`
	SessionID  *string  `json:"sessionId"`
	Workspace  *string  `json:"workspace"`
	Quote      *string  `json:"quote,omitempty"`
	Turn       *int     `json:"turn,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
}

// Item 与 Node 侧的条目结构一一对应。
type Item struct {
	ID           string   `json:"id"`
	Type         string   `json:"type"`
	Layer        string   `json:"layer"`
	Notebook     *string  `json:"notebook"`
	Title        string   `json:"title"`
	Content      string   `json:"content"`
	Tags         []string `json:"tags"`
	Questions    []string `json:"questions,omitempty"`
	Refs         []string `json:"refs,omitempty"`
	IndexMode    bool     `json:"indexMode,omitempty"`
	Importance   int      `json:"importance"`
	Status       string   `json:"status"`
	Pinned       bool     `json:"pinned"`
	TTLDays      *int     `json:"ttlDays"`
	ExpiresAt    *string  `json:"expiresAt"`
	Source       Source   `json:"source"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
	LastAccessAt string   `json:"lastAccessAt"`
	AccessCount  int      `json:"accessCount"`
	Version      int      `json:"version"`
	Conflicts    []string `json:"conflicts"`
	DuplicateOf  *string  `json:"duplicateOf,omitempty"`
	Key          *string  `json:"key,omitempty"`
	Supersedes   []string `json:"supersedes,omitempty"`
	SupersededBy *string  `json:"supersededBy,omitempty"`
	ValidFrom    *string  `json:"validFrom,omitempty"`
	ValidTo      *string  `json:"validTo,omitempty"`
}

// AuditEntry 是 changelog 的一行。
type AuditEntry struct {
	At     string          `json:"at"`
	Action string          `json:"action"`
	Detail string          `json:"detail"`
	Actor  string          `json:"actor"`
	Kind   string          `json:"kind,omitempty"`
	Change json.RawMessage `json:"change,omitempty"`
}

// State 是一次完整快照。
type State struct {
	Version   int             `json:"version"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
	Settings  json.RawMessage `json:"settings"`
	Items     []Item          `json:"items"`
	Audit     []AuditEntry    `json:"audit"`
	Meta      json.RawMessage `json:"meta"`
}

// BackupInfo 描述 backups/ 下一个文件。
type BackupInfo struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Bytes      int64  `json:"bytes"`
	ModifiedAt string `json:"modifiedAt"`
}

// Store 是 SQLite 句柄。
type Store struct {
	db   *sql.DB
	path string
	logf func(string, ...any)
	mu   sync.Mutex
}

// execer 让迁移步骤既能跑在 *sql.DB 上也能跑在事务里。
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
}

// SchemaVersion 是当前迁移版本。
const SchemaVersion = 4

// Open 打开数据库并执行迁移。
func Open(path string, logf func(string, ...any)) (*Store, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	dsn := dsnFor(path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w (dsn=%s)", err, dsn)
	}
	db.SetMaxOpenConns(4)
	s := &Store{db: db, path: path, logf: logf}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化数据库失败: %w (dsn=%s)", err, dsn)
	}
	if err := s.backfillIndexes(); err != nil {
		db.Close()
		return nil, fmt.Errorf("补齐索引失败: %w (dsn=%s)", err, dsn)
	}
	// 旧库的 relationships 里只有 conflict 边（甚至一条都没有）：开机补一次相关边，
	// 让图谱在第一次检索之前就有东西可走。失败不影响启动，检索仍可用。
	if err := s.SyncRelatedEdges(); err != nil {
		logf("自动建边失败（不影响启动）：%v", err)
	}
	logf("SQLite 已打开：%s", path)
	return s, nil
}

// Path 返回数据库路径。
func (s *Store) Path() string { return s.path }

// Close 关闭数据库。
func (s *Store) Close() {
	if s.db != nil {
		s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
		s.db.Close()
	}
}

func (s *Store) migrate() error {
	steps := []struct {
		version int
		desc    string
		run     func(execer) error
	}{
		{1, "初始结构：memories/events/assets/relationships/changelog/config", migrateV1},
		{2, "FTS5 全文索引 items_fts", migrateV2},
		{3, "语义向量表 memory_vectors", migrateV3},
		{4, "过滤用 items_meta 表", migrateV4},
	}
	// 迁移版本表与 Node 回退层分开：两边版本号含义不同（Node v2=向量表，Go v2=FTS5）。
	// 共用 schema_migrations 会让 Go 看到旧库的 version=2 而跳过建 items_fts，检索直接报错。
	// 独立命名空间后，Go 对任何旧库都从 0 跑一遍幂等迁移（全部 CREATE IF NOT EXISTS + 回填），
	// 既能接管 Node 建的库，也不会污染回退层的版本记录。
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS service_migrations (
		version INTEGER PRIMARY KEY,
		description TEXT NOT NULL DEFAULT '',
		applied_at TEXT NOT NULL
	)`); err != nil {
		return err
	}
	var current int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM service_migrations`).Scan(&current); err != nil {
		return err
	}
	for _, step := range steps {
		if step.version <= current {
			continue
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if err := step.run(tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("迁移 v%d 失败: %w", step.version, err)
		}
		if _, err := tx.Exec(`INSERT INTO service_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
			step.version, step.desc, time.Now().UTC().Format(time.RFC3339)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		s.logf("数据库迁移 v%d 完成（%s）", step.version, step.desc)
	}
	return nil
}

// backfillIndexes 给接管过来的旧库补齐全文索引与语义向量。
// Node 回退层用不了 FTS5，它建的库里 items_fts / memory_vectors 是空的；
// 如果只在条目变更时才写索引，升级后旧记忆会检索不到。
func (s *Store) backfillIndexes() error {
	total := 0
	for _, table := range []string{"memories", "events", "assets"} {
		var count int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
			return err
		}
		total += count
	}
	var indexed int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM items_fts`).Scan(&indexed); err != nil {
		return err
	}
	var vectored int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM memory_vectors`).Scan(&vectored); err != nil {
		return err
	}
	if indexed == total && vectored == total {
		return nil
	}
	state, err := s.Load()
	if err != nil {
		return err
	}
	if len(state.Items) == 0 {
		return nil
	}
	if err := s.UpsertItems(state.Items); err != nil {
		return err
	}
	s.logf("已补齐旧库索引：%d 条（FTS5 + 语义向量）", len(state.Items))
	return nil
}

func migrateV1(db execer) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY, layer TEXT NOT NULL, type TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_accessed TEXT,
			access_count INTEGER NOT NULL DEFAULT 0,
			importance_score REAL NOT NULL DEFAULT 0.5, confidence REAL,
			freshness_period INTEGER, status TEXT NOT NULL DEFAULT 'active')`,
		`CREATE INDEX IF NOT EXISTS idx_memories_layer_type ON memories (layer, type)`,
		`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at, last_accessed)`,
		`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance_score DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status)`,
		`CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, event_type TEXT NOT NULL,
			title TEXT, summary TEXT, content TEXT, tags TEXT, participants TEXT,
			importance REAL DEFAULT 0.5, session_id TEXT)`,
		`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp DESC)`,
		`CREATE TABLE IF NOT EXISTS assets (
			id TEXT PRIMARY KEY, asset_type TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
			sensitivity_level TEXT NOT NULL DEFAULT 'low', data TEXT, access_control TEXT,
			created_at TEXT NOT NULL, last_used TEXT, usage_count INTEGER DEFAULT 0, tags TEXT)`,
		`CREATE TABLE IF NOT EXISTS relationships (
			id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
			edge_type TEXT NOT NULL, weight REAL DEFAULT 0.5, created_at TEXT NOT NULL,
			metadata TEXT, UNIQUE (source_id, target_id, edge_type))`,
		`CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships (source_id)`,
		`CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships (target_id)`,
		`CREATE INDEX IF NOT EXISTS idx_relationships_edge ON relationships (edge_type, weight DESC)`,
		`CREATE TABLE IF NOT EXISTS changelog (
			id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, operation TEXT NOT NULL,
			layer TEXT NOT NULL, target_id TEXT NOT NULL, change_details TEXT,
			reason TEXT, triggered_by TEXT, session_id TEXT)`,
		`CREATE INDEX IF NOT EXISTS idx_changelog_timestamp ON changelog (timestamp DESC)`,
		`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func migrateV2(db execer) error {
	_, err := db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
		item_id UNINDEXED, kind UNINDEXED, search_text, tokenize = 'unicode61')`)
	return err
}

func migrateV4(db execer) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS items_meta (
		id TEXT PRIMARY KEY, layer TEXT, type TEXT, status TEXT, notebook TEXT, tags TEXT)`); err != nil {
		return err
	}
	// 回填已有条目
	rows, err := db.Query(`SELECT id, layer, type, status, COALESCE(metadata, '{}') FROM memories`)
	if err != nil {
		return err
	}
	type row struct{ id, layer, itemType, status, metadata string }
	buffer := []row{}
	for rows.Next() {
		var entry row
		if err := rows.Scan(&entry.id, &entry.layer, &entry.itemType, &entry.status, &entry.metadata); err != nil {
			rows.Close()
			return err
		}
		buffer = append(buffer, entry)
	}
	rows.Close()
	for _, entry := range buffer {
		notebook, tags := "", "[]"
		var meta struct {
			Notebook *string  `json:"notebook"`
			Tags     []string `json:"tags"`
		}
		if json.Unmarshal([]byte(entry.metadata), &meta) == nil {
			if meta.Notebook != nil {
				notebook = *meta.Notebook
			}
			if len(meta.Tags) > 0 {
				encoded, _ := json.Marshal(meta.Tags)
				tags = string(encoded)
			}
		}
		if _, err := db.Exec(`INSERT OR REPLACE INTO items_meta (id, layer, type, status, notebook, tags)
			VALUES (?, ?, ?, ?, ?, ?)`, entry.id, entry.layer, entry.itemType, entry.status, notebook, tags); err != nil {
			return err
		}
	}
	// events / assets 也补上
	eventRows, err := db.Query(`SELECT id, COALESCE(tags, '[]') FROM events`)
	if err == nil {
		for eventRows.Next() {
			var id, tags string
			if err := eventRows.Scan(&id, &tags); err == nil {
				db.Exec(`INSERT OR REPLACE INTO items_meta (id, layer, type, status, notebook, tags)
					VALUES (?, 'L5', 'note', 'active', 'daily', ?)`, id, tags)
			}
		}
		eventRows.Close()
	}
	assetRows, err := db.Query(`SELECT id, COALESCE(tags, '[]'), COALESCE(data, '{}') FROM assets`)
	if err == nil {
		for assetRows.Next() {
			var id, tags, data string
			if err := assetRows.Scan(&id, &tags, &data); err == nil {
				db.Exec(`INSERT OR REPLACE INTO items_meta (id, layer, type, status, notebook, tags)
					VALUES (?, 'L4', 'note', 'active', 'asset', ?)`, id, tags)
			}
		}
		assetRows.Close()
	}
	return nil
}

func migrateV3(db execer) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS memory_vectors (
		id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL,
		signature TEXT NOT NULL, updated_at TEXT NOT NULL)`)
	return err
}

// Load 读出完整快照。
func (s *Store) Load() (*State, error) {
	state := &State{Version: SchemaVersion, Settings: json.RawMessage(`{}`), Meta: json.RawMessage(`{}`)}
	if value, ok, err := s.config("settings"); err == nil && ok {
		state.Settings = value
	}
	if value, ok, err := s.config("meta"); err == nil && ok {
		state.Meta = value
	}
	if value, ok, err := s.config("createdAt"); err == nil && ok {
		var createdAt string
		if json.Unmarshal(value, &createdAt) == nil {
			state.CreatedAt = createdAt
		}
	}
	if state.CreatedAt == "" {
		state.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)

	items := []Item{}
	memories, err := s.loadMemories()
	if err != nil {
		return nil, err
	}
	items = append(items, memories...)
	events, err := s.loadEvents()
	if err != nil {
		return nil, err
	}
	items = append(items, events...)
	assets, err := s.loadAssets()
	if err != nil {
		return nil, err
	}
	items = append(items, assets...)

	conflicts, err := s.conflictEdges()
	if err != nil {
		return nil, err
	}
	for index := range items {
		if related, ok := conflicts[items[index].ID]; ok {
			items[index].Conflicts = mergeUnique(items[index].Conflicts, related)
		}
	}
	state.Items = items

	audit, err := s.loadAudit()
	if err != nil {
		return nil, err
	}
	state.Audit = audit
	return state, nil
}

func (s *Store) loadMemories() ([]Item, error) {
	rows, err := s.db.Query(`SELECT id, layer, type, title, content, metadata, created_at, updated_at,
		COALESCE(last_accessed, ''), access_count, importance_score, COALESCE(freshness_period, 0), status
		FROM memories`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var item Item
		var metadata string
		var freshness int
		var score float64
		if err := rows.Scan(&item.ID, &item.Layer, &item.Type, &item.Title, &item.Content, &metadata,
			&item.CreatedAt, &item.UpdatedAt, &item.LastAccessAt, &item.AccessCount, &score, &freshness, &item.Status); err != nil {
			return nil, err
		}
		item.Importance = clampImportance(int(math.Round(score * 10)))
		item.Tags = []string{}
		item.Conflicts = []string{}
		if freshness > 0 {
			days := freshness / 86400
			item.TTLDays = &days
		}
		var meta struct {
			Notebook     *string  `json:"notebook"`
			Tags         []string `json:"tags"`
			Questions    []string `json:"questions"`
			Refs         []string `json:"refs"`
			IndexMode    bool     `json:"indexMode"`
			Pinned       bool     `json:"pinned"`
			ExpiresAt    *string  `json:"expiresAt"`
			Source       *Source  `json:"source"`
			Version      int      `json:"version"`
			Conflicts    []string `json:"conflicts"`
			DuplicateOf  *string  `json:"duplicateOf"`
			Key          *string  `json:"key"`
			Supersedes   []string `json:"supersedes"`
			SupersededBy *string  `json:"supersededBy"`
			ValidFrom    *string  `json:"validFrom"`
			ValidTo      *string  `json:"validTo"`
		}
		if err := json.Unmarshal([]byte(metadata), &meta); err == nil {
			item.Notebook = meta.Notebook
			if meta.Tags != nil {
				item.Tags = meta.Tags
			}
			if meta.Questions != nil {
				item.Questions = meta.Questions
			}
			if meta.Refs != nil {
				item.Refs = meta.Refs
			}
			item.IndexMode = meta.IndexMode
			item.Pinned = meta.Pinned
			item.ExpiresAt = meta.ExpiresAt
			if meta.Source != nil {
				item.Source = *meta.Source
			}
			if meta.Version > 0 {
				item.Version = meta.Version
			}
			if meta.Conflicts != nil {
				item.Conflicts = meta.Conflicts
			}
			item.DuplicateOf = meta.DuplicateOf
			item.Key = meta.Key
			if meta.Supersedes != nil {
				item.Supersedes = meta.Supersedes
			}
			item.SupersededBy = meta.SupersededBy
			item.ValidFrom = meta.ValidFrom
			item.ValidTo = meta.ValidTo
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) loadEvents() ([]Item, error) {
	rows, err := s.db.Query(`SELECT id, timestamp, COALESCE(title, ''), COALESCE(content, ''), COALESCE(summary, ''),
		COALESCE(tags, '[]'), COALESCE(importance, 0.5), session_id FROM events`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var item Item
		var timestamp, content, summary, tagJSON string
		var importance float64
		var sessionID sql.NullString
		if err := rows.Scan(&item.ID, &timestamp, &item.Title, &content, &summary, &tagJSON, &importance, &sessionID); err != nil {
			return nil, err
		}
		item.Type = "note"
		item.Layer = "L5"
		notebook := "daily"
		item.Notebook = &notebook
		item.Content = content
		if content == "" {
			item.Content = summary
		}
		json.Unmarshal([]byte(tagJSON), &item.Tags)
		if item.Tags == nil {
			item.Tags = []string{}
		}
		item.Conflicts = []string{}
		item.Importance = clampImportance(int(math.Round(importance * 10)))
		item.CreatedAt = timestamp
		item.UpdatedAt = timestamp
		item.LastAccessAt = timestamp
		item.Version = 1
		item.Source = Source{Kind: "user"}
		if sessionID.Valid {
			value := sessionID.String
			item.Source.SessionID = &value
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) loadAssets() ([]Item, error) {
	rows, err := s.db.Query(`SELECT id, name, COALESCE(description, ''), COALESCE(data, '{}'),
		created_at, COALESCE(last_used, created_at), COALESCE(usage_count, 0), COALESCE(tags, '[]') FROM assets`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var item Item
		var data, tagJSON string
		var score float64
		if err := rows.Scan(&item.ID, &item.Title, &item.Content, &data, &item.CreatedAt, &item.LastAccessAt, &item.AccessCount, &tagJSON); err != nil {
			return nil, err
		}
		var payload struct {
			Importance float64 `json:"importance"`
			Status     string  `json:"status"`
			Pinned     bool    `json:"pinned"`
			Version    int     `json:"version"`
		}
		json.Unmarshal([]byte(data), &payload)
		score = payload.Importance
		item.Type = "note"
		item.Layer = "L4"
		notebook := "asset"
		item.Notebook = &notebook
		item.Status = payload.Status
		if item.Status == "" {
			item.Status = "active"
		}
		item.Pinned = payload.Pinned
		item.Version = payload.Version
		if item.Version == 0 {
			item.Version = 1
		}
		item.Conflicts = []string{}
		item.Importance = clampImportance(int(math.Round(score * 10)))
		json.Unmarshal([]byte(tagJSON), &item.Tags)
		if item.Tags == nil {
			item.Tags = []string{}
		}
		item.Source = Source{Kind: "user"}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) conflictEdges() (map[string][]string, error) {
	rows, err := s.db.Query(`SELECT source_id, target_id FROM relationships WHERE edge_type = 'conflict'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var source, target string
		if err := rows.Scan(&source, &target); err != nil {
			return nil, err
		}
		out[source] = append(out[source], target)
	}
	return out, rows.Err()
}

func (s *Store) loadAudit() ([]AuditEntry, error) {
	rows, err := s.db.Query(`SELECT timestamp, operation, COALESCE(reason, ''), COALESCE(triggered_by, 'system'), COALESCE(change_details, '') FROM changelog ORDER BY timestamp ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var entry AuditEntry
		var details string
		if err := rows.Scan(&entry.At, &entry.Action, &entry.Detail, &entry.Actor, &details); err != nil {
			return nil, err
		}
		if details != "" && json.Valid([]byte(details)) {
			entry.Kind = "change"
			entry.Change = json.RawMessage(details)
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

// UpsertItems 在一个事务里写入一批条目（含 FTS 与向量）。
func (s *Store) UpsertItems(items []Item) error {
	if len(items) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for _, item := range items {
		if err := s.upsertItem(tx, item); err != nil {
			tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	// 条目变了，相关边跟着重建（已持有 s.mu，走 locked 版本）。
	return s.syncRelatedEdgesLocked()
}

func (s *Store) upsertItem(tx *sql.Tx, item Item) error {
	score := float64(clampImportance(item.Importance)) / 10
	switch {
	case item.Type == "note" && item.Notebook != nil && *item.Notebook == "daily":
		if _, err := tx.Exec(`DELETE FROM events WHERE id = ?`, item.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO events (id, timestamp, event_type, title, summary, content, tags, participants, importance, session_id)
			VALUES (?, ?, 'daily', ?, ?, ?, ?, '[]', ?, ?)`,
			item.ID, item.CreatedAt, item.Title, item.Content, item.Content, jsonString(item.Tags), score, item.Source.SessionID); err != nil {
			return err
		}
	case item.Type == "note" && item.Notebook != nil && *item.Notebook == "asset":
		if _, err := tx.Exec(`DELETE FROM assets WHERE id = ?`, item.ID); err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]any{
			"content": item.Content, "importance": score, "status": item.Status,
			"updatedAt": item.UpdatedAt, "version": item.Version, "pinned": item.Pinned,
		})
		if _, err := tx.Exec(`INSERT INTO assets (id, asset_type, name, description, sensitivity_level, data, access_control, created_at, last_used, usage_count, tags)
			VALUES (?, 'notebook', ?, ?, 'low', ?, '{}', ?, ?, ?, ?)`,
			item.ID, item.Title, item.Content, string(payload), item.CreatedAt, item.LastAccessAt, item.AccessCount, jsonString(item.Tags)); err != nil {
			return err
		}
	default:
		// 写入没带问法时沿用库里已有的，避免旧副本把问法抹平（与 Node 侧同一条保护）。
		questions := item.Questions
		if len(questions) == 0 {
			questions = storedQuestions(tx, item.ID)
		}
		if questions == nil {
			questions = []string{}
		}
		metadata, _ := json.Marshal(map[string]any{
			"notebook": item.Notebook, "tags": item.Tags, "pinned": item.Pinned,
			"questions": questions, "refs": item.Refs, "indexMode": item.IndexMode,
			"expiresAt": item.ExpiresAt, "source": item.Source, "version": item.Version,
			"conflicts": item.Conflicts, "duplicateOf": item.DuplicateOf,
			"key": item.Key, "supersedes": item.Supersedes, "supersededBy": item.SupersededBy,
			"validFrom": item.ValidFrom, "validTo": item.ValidTo,
		})
		freshness := sql.NullInt64{}
		if item.TTLDays != nil {
			freshness = sql.NullInt64{Int64: int64(*item.TTLDays) * 86400, Valid: true}
		}
		if _, err := tx.Exec(`INSERT INTO memories (id, layer, type, title, content, metadata, created_at, updated_at, last_accessed, access_count, importance_score, confidence, freshness_period, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				layer = excluded.layer, type = excluded.type, title = excluded.title, content = excluded.content,
				metadata = excluded.metadata, updated_at = excluded.updated_at, last_accessed = excluded.last_accessed,
				access_count = excluded.access_count, importance_score = excluded.importance_score,
				freshness_period = excluded.freshness_period, status = excluded.status`,
			item.ID, item.Layer, item.Type, item.Title, item.Content, string(metadata),
			item.CreatedAt, item.UpdatedAt, nullString(item.LastAccessAt), item.AccessCount, score, freshness, item.Status); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM items_fts WHERE item_id = ?`, item.ID); err != nil {
		return err
	}
	searchText := text.SearchText(item.Title, item.Content, item.Tags)
	if _, err := tx.Exec(`INSERT INTO items_fts (item_id, kind, search_text) VALUES (?, ?, ?)`,
		item.ID, item.Type, searchText); err != nil {
		return err
	}
	vector := text.Embed(text.SearchText(item.Title, item.Content, item.Tags))
	encoded := encodeVector(vector)
	signature := signatureOf(item)
	if _, err := tx.Exec(`INSERT INTO memory_vectors (id, dim, vec, signature, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET vec = excluded.vec, signature = excluded.signature, updated_at = excluded.updated_at`,
		item.ID, text.Dim, encoded, signature, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM relationships WHERE source_id = ? AND edge_type = 'conflict'`, item.ID); err != nil {
		return err
	}
	for _, target := range item.Conflicts {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO relationships (id, source_id, target_id, edge_type, weight, created_at, metadata)
			VALUES (?, ?, ?, 'conflict', 1.0, ?, '{}')`,
			item.ID+":"+target, item.ID, target, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	if err := s.upsertMeta(tx, item); err != nil {
		return err
	}
	return nil
}

// DeleteItems 删除条目及其派生索引。
func (s *Store) DeleteItems(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for _, id := range ids {
		statements := []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM memories WHERE id = ?`, []any{id}},
			{`DELETE FROM events WHERE id = ?`, []any{id}},
			{`DELETE FROM assets WHERE id = ?`, []any{id}},
			{`DELETE FROM items_fts WHERE item_id = ?`, []any{id}},
			{`DELETE FROM memory_vectors WHERE id = ?`, []any{id}},
			{`DELETE FROM relationships WHERE source_id = ? OR target_id = ?`, []any{id, id}},
			{`DELETE FROM items_meta WHERE id = ?`, []any{id}},
		}
		for _, statement := range statements {
			if _, err := tx.Exec(statement.sql, statement.args...); err != nil {
				tx.Rollback()
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	// 删掉的条目可能带着边一起走了，剩下的条目需要重新连边。
	return s.syncRelatedEdgesLocked()
}

// upsertMeta 同步过滤用元数据（layer/type/status/notebook/tags）。
func (s *Store) upsertMeta(tx *sql.Tx, item Item) error {
	notebook := ""
	if item.Notebook != nil {
		notebook = *item.Notebook
	}
	tags := jsonString(item.Tags)
	_, err := tx.Exec(`INSERT INTO items_meta (id, layer, type, status, notebook, tags)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			layer = excluded.layer, type = excluded.type, status = excluded.status,
			notebook = excluded.notebook, tags = excluded.tags`,
		item.ID, item.Layer, item.Type, item.Status, notebook, tags)
	return err
}

// SetConfig 写一条配置（settings / meta / createdAt / version）。
func (s *Store) SetConfig(key string, value json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, string(value), time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Store) config(key string) (json.RawMessage, bool, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM config WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(value), true, nil
}

// AppendAudit 追加审计记录。
func (s *Store) AppendAudit(entries []AuditEntry) error {
	if len(entries) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for index, entry := range entries {
		layer, targetID, details := auditChangeColumns(entry)
		if _, err := tx.Exec(`INSERT INTO changelog (id, timestamp, operation, layer, target_id, change_details, reason, triggered_by, session_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			fmt.Sprintf("%s-%s-%d", entry.At, entry.Action, index), entry.At, entry.Action, layer, targetID, details, entry.Detail, entry.Actor); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// ReplaceAudit 用给定记录替换全部审计（compact 后调用）。
func (s *Store) ReplaceAudit(entries []AuditEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM changelog`); err != nil {
		tx.Rollback()
		return err
	}
	for index, entry := range entries {
		layer, targetID, details := auditChangeColumns(entry)
		if _, err := tx.Exec(`INSERT INTO changelog (id, timestamp, operation, layer, target_id, change_details, reason, triggered_by, session_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			fmt.Sprintf("%s-%s-%d", entry.At, entry.Action, index), entry.At, entry.Action, layer, targetID, details, entry.Detail, entry.Actor); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// auditChangeColumns 把结构化变更拆到 changelog 的索引列；旧审计保持 '-'/NULL。
func auditChangeColumns(entry AuditEntry) (layer, targetID, details string) {
	layer, targetID, details = "-", "-", ""
	if entry.Kind != "change" || len(entry.Change) == 0 || !json.Valid(entry.Change) {
		return layer, targetID, details
	}
	var change struct {
		Layer  string `json:"layer"`
		ItemID string `json:"itemId"`
	}
	if err := json.Unmarshal(entry.Change, &change); err == nil {
		if change.Layer != "" {
			layer = change.Layer
		}
		if change.ItemID != "" {
			targetID = change.ItemID
		}
	}
	return layer, targetID, string(entry.Change)
}

// Stats 返回各表行数与大小。
func (s *Store) Stats() (map[string]int64, error) {
	out := map[string]int64{}
	queries := map[string]string{
		"memories":      `SELECT COUNT(*) FROM memories`,
		"events":        `SELECT COUNT(*) FROM events`,
		"assets":        `SELECT COUNT(*) FROM assets`,
		"relationships": `SELECT COUNT(*) FROM relationships`,
		"changelog":     `SELECT COUNT(*) FROM changelog`,
		"vectors":       `SELECT COUNT(*) FROM memory_vectors`,
		"ftsRows":       `SELECT COUNT(*) FROM items_fts`,
	}
	for key, query := range queries {
		var count int64
		if err := s.db.QueryRow(query).Scan(&count); err != nil {
			return nil, err
		}
		out[key] = count
	}
	var pageSize, pageCount int64
	s.db.QueryRow(`PRAGMA page_size`).Scan(&pageSize)
	s.db.QueryRow(`PRAGMA page_count`).Scan(&pageCount)
	out["bytes"] = pageSize * pageCount
	return out, nil
}

// Backup 把数据库复制到 backups/。
func (s *Store) Backup(tag string) (BackupInfo, error) {
	dir := filepath.Join(filepath.Dir(s.path), "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return BackupInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	stamp := time.Now().UTC().Format("20060102-150405")
	target := filepath.Join(dir, fmt.Sprintf("backup_%s_%s.sqlite3", stamp, tag))
	data, err := os.ReadFile(s.path)
	if err != nil {
		return BackupInfo{}, err
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return BackupInfo{}, err
	}
	info, _ := os.Stat(target)
	pruneBackups(dir, 10)
	return BackupInfo{Name: filepath.Base(target), Path: target, Bytes: info.Size(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano)}, nil
}

// ListBackups 列出备份文件（新到旧）。
func (s *Store) ListBackups() ([]BackupInfo, error) {
	dir := filepath.Join(filepath.Dir(s.path), "backups")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []BackupInfo{}, nil
		}
		return nil, err
	}
	out := []BackupInfo{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		out = append(out, BackupInfo{
			Name: entry.Name(), Path: filepath.Join(dir, entry.Name()),
			Bytes: info.Size(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
		})
	}
	sort.Slice(out, func(left, right int) bool { return out[left].ModifiedAt > out[right].ModifiedAt })
	return out, nil
}

// Restore 用备份替换当前数据库。
func (s *Store) Restore(name string) (string, error) {
	dir := filepath.Join(filepath.Dir(s.path), "backups")
	source := filepath.Join(dir, filepath.Base(name))
	if _, err := os.Stat(source); err != nil {
		return "", fmt.Errorf("备份不存在: %s", name)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.db.Close()
	corrupt := fmt.Sprintf("%s.corrupt-%d", s.path, time.Now().Unix())
	if err := os.Rename(s.path, corrupt); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(s.path, data, 0o644); err != nil {
		return "", err
	}
	db, err := sql.Open("sqlite", dsnFor(s.path))
	if err != nil {
		return "", err
	}
	s.db = db
	return corrupt, nil
}

// Verify 做完整性检查。
func (s *Store) Verify() (bool, string, error) {
	var verdict string
	if err := s.db.QueryRow(`PRAGMA quick_check`).Scan(&verdict); err != nil {
		return false, err.Error(), err
	}
	return verdict == "ok", verdict, nil
}

// DB 暴露底层句柄（检索层用）。
func (s *Store) DB() *sql.DB { return s.db }

// ---------------------------------------------------------------- 辅助函数 --

func clampImportance(value int) int {
	if value < 1 {
		return 1
	}
	if value > 10 {
		return 10
	}
	return value
}

func jsonString(value []string) string {
	if value == nil {
		return "[]"
	}
	data, _ := json.Marshal(value)
	return string(data)
}

// storedQuestions 读库里已经存着的问法；读不到就返回 nil（调用方会补成空数组）。
func storedQuestions(tx *sql.Tx, id string) []string {
	var metadata string
	if err := tx.QueryRow(`SELECT metadata FROM memories WHERE id = ?`, id).Scan(&metadata); err != nil {
		return nil
	}
	var meta struct {
		Questions []string `json:"questions"`
	}
	if err := json.Unmarshal([]byte(metadata), &meta); err != nil {
		return nil
	}
	return meta.Questions
}

func nullString(value string) sql.NullString {
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

func mergeUnique(left, right []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range append(append([]string{}, left...), right...) {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func pruneBackups(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for index, name := range names {
		if index < keep {
			continue
		}
		os.Remove(filepath.Join(dir, name))
	}
}

// encodeVector 把 f32 向量按小端序编码成 BLOB。
func encodeVector(vector []float32) []byte {
	out := make([]byte, len(vector)*4)
	for index, value := range vector {
		binary.LittleEndian.PutUint32(out[index*4:], math.Float32bits(value))
	}
	return out
}

// signatureOf 是条目的内容指纹：内容变化时重算向量。
func signatureOf(item Item) string {
	return fmt.Sprintf("%s|%d|%d|%s|%d|%t|%s|%v",
		item.UpdatedAt, item.Version, item.AccessCount, item.Status, item.Importance, item.Pinned,
		stringValue(item.ExpiresAt), item.Conflicts)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// dsnFor 构造跨平台（尤其 Windows 盘符）的 SQLite URI。
func dsnFor(path string) string {
	normalized := filepath.ToSlash(path)
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	return "file://" + normalized +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=temp_store(memory)&_pragma=foreign_keys(1)"
}
