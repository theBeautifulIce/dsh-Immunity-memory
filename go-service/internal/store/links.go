package store

import (
	"database/sql"
	"fmt"
	"math"
	"time"
)

// ManualEdgeType 是人工建立的关联边。
//
// 与自动生成的 related 边分开存：自动建边每次都会把 related 边整批删掉重建，
// 人工边不会受牵连。面板里「加一条关联」写的就是这种边，用来纠正余弦算错的关系，
// 或者把词面完全不同、但确实相关的一对条目连起来。
const ManualEdgeType = "manual"

// Link 是一条与某条目直接相连的边（对面那一端的 id + 边类型 + 权重）。
type Link struct {
	ID        string  `json:"id"`
	EdgeType  string  `json:"edgeType"`
	Weight    float64 `json:"weight"`
	CreatedAt string  `json:"createdAt,omitempty"`
}

// ListLinks 返回与 id 直接相连的边，按权重降序。
//
// 只读、不做任何写入：面板打开详情页时调用，走不通就当没有关联，不影响别的功能。
func (s *Store) ListLinks(id string, minWeight float64, limit int) ([]Link, error) {
	if id == "" {
		return nil, fmt.Errorf("缺少条目 id")
	}
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	if minWeight < 0 {
		minWeight = 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT source_id, target_id, edge_type, weight, created_at
		FROM relationships
		WHERE (source_id = ? OR target_id = ?) AND weight >= ?
		ORDER BY weight DESC, created_at DESC LIMIT ?`, id, id, minWeight, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Link, 0, 8)
	for rows.Next() {
		var source, target, edgeType, createdAt string
		var weight float64
		if err := rows.Scan(&source, &target, &edgeType, &weight, &createdAt); err != nil {
			return nil, err
		}
		other := target
		if source != id {
			other = source
		}
		out = append(out, Link{ID: other, EdgeType: edgeType, Weight: weight, CreatedAt: createdAt})
	}
	return out, rows.Err()
}

// UpsertLink 建立一条人工关联边。
//
// 两端必须都是库里存在的条目；方向按字典序归一，同一对条目只留一条边（否则
// memory_search 的图谱通道会把同一对条目数两次）。权重限制在 (0, 1]。
func (s *Store) UpsertLink(sourceID, targetID string, weight float64) (Link, error) {
	if sourceID == "" || targetID == "" {
		return Link{}, fmt.Errorf("缺少条目 id")
	}
	if sourceID == targetID {
		return Link{}, fmt.Errorf("不能把条目连到自己")
	}
	if !(weight > 0) {
		weight = 1
	}
	if weight > 1 {
		weight = 1
	}
	requested := sourceID
	if sourceID > targetID {
		sourceID, targetID = targetID, sourceID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range []string{sourceID, targetID} {
		var exists int
		err := s.db.QueryRow(`SELECT 1 FROM memories WHERE id = ?`, id).Scan(&exists)
		if err == sql.ErrNoRows {
			return Link{}, fmt.Errorf("条目不存在：%s", id)
		}
		if err != nil {
			return Link{}, err
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	weight = math.Round(weight*1000) / 1000
	if _, err := s.db.Exec(`INSERT OR REPLACE INTO relationships
		(id, source_id, target_id, edge_type, weight, created_at, metadata)
		VALUES (?, ?, ?, ?, ?, ?, '{}')`,
		sourceID+":"+targetID+":manual", sourceID, targetID, ManualEdgeType, weight, now); err != nil {
		return Link{}, err
	}
	other := targetID
	if sourceID != requested {
		other = sourceID
	}
	return Link{ID: other, EdgeType: ManualEdgeType, Weight: weight, CreatedAt: now}, nil
}

// DeleteLink 删除一对条目之间的人工关联边（两个方向一起删）。
//
// 只动 manual 边：自动建出来的 related 边不接受手工删除，否则下次重建又会长回来，
// 反而让人以为删除没生效。
func (s *Store) DeleteLink(sourceID, targetID string) (int64, error) {
	if sourceID == "" || targetID == "" {
		return 0, fmt.Errorf("缺少条目 id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.db.Exec(`DELETE FROM relationships
		WHERE edge_type = ? AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`,
		ManualEdgeType, sourceID, targetID, targetID, sourceID)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
