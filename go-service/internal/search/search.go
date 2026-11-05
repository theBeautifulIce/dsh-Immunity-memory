// Package search 是高并发检索层（设计文档 §5.1 / §5.2 / §5.5）。
//
//   基础检索：SQLite FTS5 + bm25() 排序（中文用二元组预切词，见 text.SearchText）
//   语义检索：向量表 + 批量余弦（Go 实现；大批量可以转交 Rust 核心，见 native 包）
//   关系图谱：BFS，按边权与 0.8 衰减因子计算相关度
//   结果融合：fulltext / semantic / graph 三路加权，权重归一化
package search

import (
	"database/sql"
	"encoding/binary"
	"fmt"
	"math"
	"sort"
	"strings"

		"dsh-memory-service/internal/text"
)

// Filters 是检索过滤条件。
type Filters struct {
	Layer    string   `json:"layer"`
	Type     string   `json:"type"`
	Notebook string   `json:"notebook"`
	Status   string   `json:"status"`
	Tags     []string `json:"tags"`
}

// Weights 是融合权重。
type Weights struct {
	Fulltext float64 `json:"fulltext"`
	Semantic float64 `json:"semantic"`
	Graph    float64 `json:"graph"`
}

// Breakdown 是一路结果的分解得分。
type Breakdown struct {
	Fulltext float64 `json:"fulltext"`
	Semantic float64 `json:"semantic"`
	Graph    float64 `json:"graph"`
	Final    float64 `json:"final"`
}

// Hit 是一条检索结果。
type Hit struct {
	ID        string    `json:"id"`
	Score     float64   `json:"score"`
	Breakdown Breakdown `json:"breakdown"`
}

// Options 是一次查询的参数。
type Options struct {
	Query         string  `json:"query"`
	Limit         int     `json:"limit"`
	Filters       Filters `json:"filters"`
	Weights       Weights `json:"weights"`
	Semantic      bool    `json:"semantic"`
	Graph         bool    `json:"graph"`
	GraphDepth    int     `json:"graphDepth"`
	GraphSeeds    int     `json:"graphSeeds"`
	GraphMinEdge  float64 `json:"graphMinWeight"`
	CandidateCap  int     `json:"candidateCap"`
	IncludeBodies bool    `json:"-"`
}

// Engine 是无状态检索引擎（所有数据在 SQLite 里）。
type Engine struct {
	db *sql.DB
}

// New 创建检索引擎。
func New(database *sql.DB) *Engine { return &Engine{db: database} }

// NormalizeWeights 归一化三路权重；全零时退化为均分。
func NormalizeWeights(weights Weights) Weights {
	total := weights.Fulltext + weights.Semantic + weights.Graph
	if total <= 0 {
		return Weights{Fulltext: 1.0 / 3, Semantic: 1.0 / 3, Graph: 1.0 / 3}
	}
	return Weights{
		Fulltext: weights.Fulltext / total,
		Semantic: weights.Semantic / total,
		Graph:    weights.Graph / total,
	}
}

// Search 执行混合检索。
func (e *Engine) Search(options Options) ([]Hit, error) {
	limit := options.Limit
	if limit <= 0 {
		limit = 10
	}
	cap := options.CandidateCap
	if cap <= 0 {
		cap = 400
	}
	weights := NormalizeWeights(options.Weights)
	tokens := text.Tokenize(options.Query)
	if len(tokens) == 0 {
		return []Hit{}, nil
	}

	fulltext, err := e.fulltextScores(options.Query, cap)
	if err != nil {
		return nil, err
	}
	allowed, err := e.filterIDs(options.Filters)
	if err != nil {
		return nil, err
	}
	candidates := make([]string, 0, len(fulltext))
	for _, entry := range fulltext {
		if allowed != nil {
			if _, ok := allowed[entry.ID]; !ok {
				continue
			}
		}
		candidates = append(candidates, entry.ID)
	}
	basic := map[string]float64{}
	for _, entry := range fulltext {
		basic[entry.ID] = entry.Score
	}

	semantic := map[string]float64{}
	if options.Semantic && len(candidates) > 0 {
		scores, err := e.semanticScores(options.Query, candidates)
		if err != nil {
			return nil, err
		}
		semantic = scores
	}

	graph := map[string]float64{}
	if options.Graph && len(candidates) > 0 {
		seeds := make([]string, 0, options.GraphSeeds)
		sorted := append([]scored{}, fulltext...)
		sort.Slice(sorted, func(left, right int) bool { return sorted[left].Score > sorted[right].Score })
		seedsCount := options.GraphSeeds
		if seedsCount <= 0 {
			seedsCount = 5
		}
		for index := 0; index < len(sorted) && index < seedsCount; index++ {
			seeds = append(seeds, sorted[index].ID)
		}
		expanded, err := e.graphBFS(seeds, options.GraphDepth, options.GraphMinEdge, 200)
		if err != nil {
			return nil, err
		}
		for id, score := range expanded {
			if allowed != nil {
				if _, ok := allowed[id]; !ok {
					continue
				}
			}
			graph[id] = score
			if _, ok := basic[id]; !ok {
				basic[id] = 0
				candidates = append(candidates, id)
			}
		}
	}

	hits := make([]Hit, 0, len(candidates))
	seen := map[string]bool{}
	for _, id := range candidates {
		if seen[id] {
			continue
		}
		seen[id] = true
		if allowed != nil {
			if _, ok := allowed[id]; !ok {
				continue
			}
		}
		fulltextScore := basic[id]
		semanticScore := semantic[id]
		graphScore := graph[id]
		final := weights.Fulltext*fulltextScore + weights.Semantic*semanticScore + weights.Graph*graphScore
		hits = append(hits, Hit{
			ID:    id,
			Score: round(final),
			Breakdown: Breakdown{
				Fulltext: round(fulltextScore),
				Semantic: round(semanticScore),
				Graph:    round(graphScore),
				Final:    round(final),
			},
		})
	}
	sort.Slice(hits, func(left, right int) bool {
		if hits[left].Score != hits[right].Score {
			return hits[left].Score > hits[right].Score
		}
		return hits[left].ID < hits[right].ID
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

type scored struct {
	ID    string
	Score float64
}

func (e *Engine) fulltextScores(query string, limit int) ([]scored, error) {
	tokens := text.Tokenize(query)
	if len(tokens) == 0 {
		return []scored{}, nil
	}
	parts := make([]string, 0, len(tokens))
	for index, token := range tokens {
		if index >= 12 {
			break
		}
		parts = append(parts, fmt.Sprintf("%q", token))
	}
	match := strings.Join(parts, " OR ")
	rows, err := e.db.Query(`SELECT item_id, bm25(items_fts) AS rank FROM items_fts
		WHERE items_fts MATCH ? ORDER BY rank LIMIT ?`, match, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []scored{}
	worst := 0.0
	for rows.Next() {
		var id string
		var rank float64
		if err := rows.Scan(&id, &rank); err != nil {
			return nil, err
		}
		if math.Abs(rank) > worst {
			worst = math.Abs(rank)
		}
		out = append(out, scored{ID: id, Score: math.Abs(rank)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if worst > 0 {
		for index := range out {
			out[index].Score = out[index].Score / worst
		}
	}
	return out, nil
}

// filterIDs 返回允许的 id 集合；无过滤条件时返回 nil（不过滤）。
func (e *Engine) filterIDs(filters Filters) (map[string]bool, error) {
	if filters.Layer == "" && filters.Type == "" && filters.Notebook == "" && (filters.Status == "" || filters.Status == "all") && len(filters.Tags) == 0 {
		return nil, nil
	}
	query := `SELECT id, layer, type, status, COALESCE(notebook, ''), COALESCE(tags, '[]') FROM items_meta`
	rows, err := e.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := map[string]bool{}
	for rows.Next() {
		var id, layer, itemType, status, notebook, tags string
		if err := rows.Scan(&id, &layer, &itemType, &status, &notebook, &tags); err != nil {
			return nil, err
		}
		if filters.Layer != "" && layer != filters.Layer {
			continue
		}
		if filters.Type != "" && itemType != filters.Type {
			continue
		}
		if filters.Notebook != "" && notebook != filters.Notebook {
			continue
		}
		if filters.Status == "usable" && status != "active" && status != "conflicted" {
			continue
		}
		if filters.Status != "" && filters.Status != "usable" && filters.Status != "all" && status != filters.Status {
			continue
		}
		allowed[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 标签过滤在 SQL 里不好表达（JSON 数组），在这里二次过滤
	if len(filters.Tags) > 0 {
		rows2, err := e.db.Query(`SELECT id, COALESCE(tags, '[]') FROM items_meta`)
		if err != nil {
			return nil, err
		}
		defer rows2.Close()
		wanted := map[string]bool{}
		for _, tag := range filters.Tags {
			wanted[strings.ToLower(tag)] = true
		}
		tagAllowed := map[string]bool{}
		for rows2.Next() {
			var id, tagJSON string
			if err := rows2.Scan(&id, &tagJSON); err != nil {
				return nil, err
			}
			if !allowed[id] {
				continue
			}
			for _, tag := range parseTags(tagJSON) {
				if wanted[strings.ToLower(tag)] {
					tagAllowed[id] = true
					break
				}
			}
		}
		allowed = tagAllowed
	}
	return allowed, nil
}

func parseTags(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return nil
	}
	body := strings.Trim(trimmed, "[]")
	if strings.TrimSpace(body) == "" {
		return nil
	}
	parts := strings.Split(body, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.Trim(strings.TrimSpace(part), `"`)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

// semanticScores 对候选条目做向量余弦（向量存 SQLite BLOB）。
func (e *Engine) semanticScores(query string, candidates []string) (map[string]float64, error) {
	out := map[string]float64{}
	if len(candidates) == 0 {
		return out, nil
	}
	queryVector := text.Embed(text.SearchText(query, "", nil))
	placeholders := make([]string, len(candidates))
	args := make([]any, len(candidates))
	for index, id := range candidates {
		placeholders[index] = "?"
		args[index] = id
	}
	rows, err := e.db.Query(fmt.Sprintf(`SELECT id, dim, vec FROM memory_vectors WHERE id IN (%s)`,
		strings.Join(placeholders, ",")), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var dim int
		var blob []byte
		if err := rows.Scan(&id, &dim, &blob); err != nil {
			return nil, err
		}
		vector := decodeVector(blob, dim)
		out[id] = float64(cosine(queryVector, vector))
	}
	return out, rows.Err()
}

func decodeVector(blob []byte, dim int) []float32 {
	if dim <= 0 || len(blob) < dim*4 {
		return make([]float32, dim)
	}
	out := make([]float32, dim)
	for index := 0; index < dim; index++ {
		bits := binary.LittleEndian.Uint32(blob[index*4:])
		out[index] = math.Float32frombits(bits)
	}
	return out
}

func cosine(left, right []float32) float32 {
	length := len(left)
	if len(right) < length {
		length = len(right)
	}
	var dot, leftNorm, rightNorm float64
	for index := 0; index < length; index++ {
		dot += float64(left[index] * right[index])
		leftNorm += float64(left[index] * left[index])
		rightNorm += float64(right[index] * right[index])
	}
	if leftNorm == 0 || rightNorm == 0 {
		return 0
	}
	return float32(dot / (math.Sqrt(leftNorm) * math.Sqrt(rightNorm)))
}

// GraphNode 是 BFS 的一个节点。
type GraphNode struct {
	ID        string  `json:"id"`
	Depth     int     `json:"depth"`
	Relevance float64 `json:"relevance"`
}

// GraphEdge 是一条边。
type GraphEdge struct {
	Source   string  `json:"source"`
	Target   string  `json:"target"`
	EdgeType string  `json:"edgeType"`
	Weight   float64 `json:"weight"`
}

// BFS 是导出的图遍历（API 用）。
func (e *Engine) BFS(seeds []string, maxDepth int, minWeight float64, maxResults int) ([]GraphNode, []GraphEdge, error) {
	if maxDepth <= 0 {
		maxDepth = 2
	}
	if maxResults <= 0 {
		maxResults = 50
	}
	visited := map[string]bool{}
	type queued struct {
		id        string
		depth     int
		relevance float64
	}
	queue := []queued{}
	for _, seed := range seeds {
		queue = append(queue, queued{id: seed, depth: 0, relevance: 1})
	}
	nodes := []GraphNode{}
	edges := []GraphEdge{}
	for len(queue) > 0 && len(nodes) < maxResults {
		current := queue[0]
		queue = queue[1:]
		if visited[current.id] || current.depth > maxDepth {
			continue
		}
		visited[current.id] = true
		nodes = append(nodes, GraphNode{ID: current.id, Depth: current.depth, Relevance: round(current.relevance)})
		if current.depth == maxDepth {
			continue
		}
		neighbors, err := e.neighbors(current.id, minWeight)
		if err != nil {
			return nil, nil, err
		}
		for _, edge := range neighbors {
			edges = append(edges, edge)
			if !visited[edge.Target] {
				queue = append(queue, queued{
					id:        edge.Target,
					depth:     current.depth + 1,
					relevance: current.relevance * edge.Weight * 0.8,
				})
			}
		}
	}
	return nodes, edges, nil
}

func (e *Engine) neighbors(id string, minWeight float64) ([]GraphEdge, error) {
	rows, err := e.db.Query(`SELECT source_id, target_id, edge_type, COALESCE(weight, 0.5) FROM relationships
		WHERE (source_id = ? OR target_id = ?) AND COALESCE(weight, 0.5) >= ? LIMIT 200`, id, id, minWeight)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GraphEdge{}
	for rows.Next() {
		var source, target, edgeType string
		var weight float64
		if err := rows.Scan(&source, &target, &edgeType, &weight); err != nil {
			return nil, err
		}
		if source == id {
			out = append(out, GraphEdge{Source: source, Target: target, EdgeType: edgeType, Weight: weight})
		} else {
			out = append(out, GraphEdge{Source: target, Target: source, EdgeType: edgeType, Weight: weight})
		}
	}
	return out, rows.Err()
}

func (e *Engine) graphBFS(seeds []string, depth int, minWeight float64, maxResults int) (map[string]float64, error) {
	nodes, _, err := e.BFS(seeds, depth, minWeight, maxResults)
	if err != nil {
		return nil, err
	}
	out := map[string]float64{}
	seedSet := map[string]bool{}
	for _, seed := range seeds {
		seedSet[seed] = true
	}
	for _, node := range nodes {
		if seedSet[node.ID] {
			continue
		}
		out[node.ID] = node.Relevance
	}
	return out, nil
}

func round(value float64) float64 {
	return math.Round(value*1000) / 1000
}

