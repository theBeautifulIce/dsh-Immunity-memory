package store

import (
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"

	"dsh-memory-service/internal/text"
)

// 自动建边的参数：与 Node 侧 lib/sqlite.js 的 RELATED_* 常量保持一致，两边算出来的
// 边应该几乎一样（只在分词实现细节上可能有极小差异）。
const (
	relatedItemMax    = 800
	relatedPostingMax = 40
	relatedNeighbors  = 3
	relatedDFRatio    = 0.35
	// RelatedEdgeMin 是 related 边权（idf 加权余弦）的下限。真库 39 条时：0.28 会剩
	// 22 条孤立、最大连通片只有 3 条；0.18 几乎全连成一片；0.22 是两头都不极端的位置。
	RelatedEdgeMin = 0.22
)

type relatedDoc struct {
	id      string
	tokens  []string
	weights map[string]float64
	norm    float64
}

type relatedEdge struct {
	to     int
	weight float64
}

// SyncRelatedEdges 重建 edge_type='related' 的边。
//
// 只描述「这两条记忆大概率在讲同一件事」：同一批罕见词、idf 加权余弦够高。它不改变
// 条目本身，只为 memory_search 的图谱通道、注入时的邻居加分、面板里的关联条目服务。
// 词面相同才能连边，换说法连不出来——那是 embedding 的活，不在这一步范围内。
func (s *Store) SyncRelatedEdges() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.syncRelatedEdgesLocked()
}

func (s *Store) syncRelatedEdgesLocked() error {
	rows, err := s.db.Query(`SELECT m.id, m.title,
			COALESCE(m.content, ''), COALESCE(meta.tags, '[]'), COALESCE(m.metadata, '{}')
		FROM memories m LEFT JOIN items_meta meta ON meta.id = m.id
		WHERE m.status IN ('active', 'conflicted')`)
	if err != nil {
		return err
	}
	type source struct{ id, title, content, tags, metadata string }
	collected := make([]source, 0, 64)
	for rows.Next() {
		var row source
		if err := rows.Scan(&row.id, &row.title, &row.content, &row.tags, &row.metadata); err != nil {
			rows.Close()
			return err
		}
		collected = append(collected, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	// 条目太多时不做全量两两比较，保留上一次的图。
	if len(collected) > relatedItemMax {
		return nil
	}
	if len(collected) < 2 {
		// 条目被删到只剩一条时，旧的 related 边就成了指向空气的悬空关系。
		_, err := s.db.Exec(`DELETE FROM relationships WHERE edge_type = 'related'`)
		return err
	}

	docs := make([]relatedDoc, 0, len(collected))
	df := make(map[string]int, 512)
	for _, row := range collected {
		joined := row.title + " " + row.content + " " + row.tags + " " + questionsText(row.metadata)
		counts := text.TokenCounts(joined)
		tokens := make([]string, 0, len(counts))
		for token := range counts {
			tokens = append(tokens, token)
			df[token]++
		}
		docs = append(docs, relatedDoc{id: row.id, tokens: tokens})
	}

	n := len(docs)
	ceiling := int(math.Floor(float64(n) * relatedDFRatio))
	if ceiling < 2 {
		ceiling = 2
	}
	for index := range docs {
		weights := make(map[string]float64, len(docs[index].tokens))
		for _, token := range docs[index].tokens {
			count := df[token]
			if count < 2 || count > ceiling {
				continue
			}
			weights[token] = math.Log(float64(n+1)/float64(count+1)) + 1
		}
		if len(weights) == 0 {
			continue
		}
		var square float64
		for _, value := range weights {
			square += value * value
		}
		docs[index].weights = weights
		docs[index].norm = math.Sqrt(square)
	}

	postings := make(map[string][]int, 512)
	for index, doc := range docs {
		for token := range doc.weights {
			postings[token] = append(postings[token], index)
		}
	}
	dots := make(map[[2]int]float64, 256)
	for token, bucket := range postings {
		if len(bucket) < 2 || len(bucket) > relatedPostingMax {
			continue
		}
		for i := 0; i < len(bucket); i++ {
			left := bucket[i]
			for j := i + 1; j < len(bucket); j++ {
				right := bucket[j]
				dots[[2]int{left, right}] += docs[left].weights[token] * docs[right].weights[token]
			}
		}
	}

	adjacency := make([][]relatedEdge, n)
	for pair, dot := range dots {
		left, right := pair[0], pair[1]
		if docs[left].norm == 0 || docs[right].norm == 0 {
			continue
		}
		weight := dot / (docs[left].norm * docs[right].norm)
		if !(weight >= RelatedEdgeMin) {
			continue
		}
		adjacency[left] = append(adjacency[left], relatedEdge{to: right, weight: weight})
		adjacency[right] = append(adjacency[right], relatedEdge{to: left, weight: weight})
	}
	for index := range adjacency {
		list := adjacency[index]
		sort.Slice(list, func(a, b int) bool { return list[a].weight > list[b].weight })
		if len(list) > relatedNeighbors {
			adjacency[index] = list[:relatedNeighbors]
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM relationships WHERE edge_type = 'related'`); err != nil {
		tx.Rollback()
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	// 每对只落一行：双向各存一条的话，反查时两端各命中一次，界面上同一条关联会出现两遍。
	// 邻接表本身是按节点各留前 N 条，这里取两侧的并集，避免丢掉只出现在一端的关系。
	pairs := make(map[[2]int]float64, len(dots))
	for from, list := range adjacency {
		for _, edge := range list {
			left, right := from, edge.to
			if left > right {
				left, right = right, left
			}
			if previous, ok := pairs[[2]int{left, right}]; !ok || edge.weight > previous {
				pairs[[2]int{left, right}] = edge.weight
			}
		}
	}
	for pair, weight := range pairs {
		sourceID := docs[pair[0]].id
		targetID := docs[pair[1]].id
		if sourceID > targetID {
			sourceID, targetID = targetID, sourceID
		}
		if _, err := tx.Exec(`INSERT OR REPLACE INTO relationships
			(id, source_id, target_id, edge_type, weight, created_at, metadata)
			VALUES (?, ?, ?, 'related', ?, ?, '{}')`,
			sourceID+":"+targetID, sourceID, targetID, math.Round(weight*1000)/1000, now); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// questionsText 从 metadata JSON 里取出「能回答什么问题」，拼成一段供分词。
// 解析失败就当没有：建边是锦上添花，不能因为一条记录的元数据坏了就整批失败。
func questionsText(metadata string) string {
	var parsed struct {
		Questions []string `json:"questions"`
	}
	if err := json.Unmarshal([]byte(metadata), &parsed); err != nil || len(parsed.Questions) == 0 {
		return ""
	}
	return strings.Join(parsed.Questions, " ")
}
