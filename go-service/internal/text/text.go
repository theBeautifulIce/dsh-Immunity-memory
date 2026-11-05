// Package text 提供与 Node 侧一致的分词、哈希向量与相似度计算。
//
// 一致性的重要性：Node 写入条目时交给 Go 的原文，Go 自己切词建索引；两边必须用
// 同一套规则，否则"检索到的"和"界面里看到的"会对不上。
package text

import (
	"math"
	"regexp"
	"strings"
	"unicode"
)

var (
	latinRe = regexp.MustCompile(`[a-z0-9][a-z0-9_+#.\-]{1,}`)
	cjkRe   = regexp.MustCompile(`[\x{3400}-\x{9fff}\x{f900}-\x{faff}]+`)
)

// Tokenize 返回去重后的 token 集合，用于生成向量。
func Tokenize(input string) []string {
	counts := TokenCounts(input)
	out := make([]string, 0, len(counts))
	for token := range counts {
		out = append(out, token)
	}
	return out
}

// TokenCounts 返回 token → 词频，用于倒排与 BM25。
func TokenCounts(input string) map[string]int {
	source := strings.ToLower(input)
	counts := make(map[string]int)
	if source == "" {
		return counts
	}
	for _, match := range latinRe.FindAllString(source, -1) {
		counts[match]++
	}
	for _, run := range cjkRe.FindAllString(source, -1) {
		rs := []rune(run)
		for index := 0; index < len(rs); index++ {
			counts[string(rs[index])]++
			if index+1 < len(rs) {
				counts[string(rs[index:index+2])]++
			}
		}
	}
	return counts
}

// SearchText 把分词结果拼成 FTS5 的检索文本（空格分隔）。
func SearchText(title, content string, tags []string) string {
	joined := title + " " + content + " " + strings.Join(tags, " ")
	counts := TokenCounts(joined)
	tokens := make([]string, 0, len(counts))
	for token := range counts {
		tokens = append(tokens, token)
	}
	return strings.Join(tokens, " ")
}

// Dim 是哈希向量的维度，必须与 Node 侧 embeddings.js 的 DEFAULT_DIM 一致。
const Dim = 384

// Embed 生成 L2 归一化的哈希向量（与 Node 侧同算法）。
func Embed(input string) []float32 {
	vector := make([]float32, Dim)
	counts := TokenCounts(input)
	if len(counts) == 0 {
		return vector
	}
	seen := make(map[string]bool, len(counts))
	for token := range counts {
		if seen[token] {
			continue
		}
		seen[token] = true
		hash := Hash32(token)
		index := int(hash % Dim)
		sign := float32(1)
		if hash&0x80000000 != 0 {
			sign = -1
		}
		vector[index] += sign
		second := int(Hash32(token+"#") % Dim)
		vector[second] += sign * 0.5
	}
	var norm float64
	for _, value := range vector {
		norm += float64(value * value)
	}
	norm = math.Sqrt(norm)
	if norm > 0 {
		for index := range vector {
			vector[index] = float32(float64(vector[index]) / norm)
		}
	}
	return vector
}

// Hash32 是 32 位 FNV-1a，与 Node 侧 hash32 保持一致。
func Hash32(input string) uint32 {
	hash := uint32(0x811c9dc5)
	for _, r := range input {
		hash ^= uint32(r)
		hash *= 0x01000193
	}
	return hash
}

// Jaccard 计算两个 token 集合的相似度。
func Jaccard(left, right map[string]int) float64 {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	shared := 0
	small, large := left, right
	if len(right) < len(left) {
		small, large = right, left
	}
	for token := range small {
		if _, ok := large[token]; ok {
			shared++
		}
	}
	return float64(shared) / float64(len(left)+len(right)-shared)
}

// IsCJK 判断是否是中文字符（调试/测试用）。
func IsCJK(r rune) bool {
	return unicode.Is(unicode.Han, r)
}
