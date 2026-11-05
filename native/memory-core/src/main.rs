//! memory-core —— dsh-memory-plugin 的原生计算核心（对应架构文档里的 Rust 计算库）。
//!
//! 协议：stdin 每一行一个 JSON 请求，stdout 每一行一个 JSON 响应。
//!   {"id":1,"cmd":"ping"}
//!   {"id":2,"cmd":"cosine","dim":384,"queryB64":"...","matrixB64":"...","count":500}
//!   {"id":3,"cmd":"importance","now":1730000000,"items":[{"createdAt":..,"lastAccessAt":..,"accessCount":..,"relatedCount":..}]}
//!   {"id":4,"cmd":"dedupe","threshold":0.82,"items":[{"id":"mem_a","tokens":["构建","构建 pnpm","pnpm"]}]}
//!   {"id":5,"cmd":"similar","tokens":["..."],"candidates":[{"id":"mem_b","tokens":["..."]}]}
//!
//! 响应：{"id":2,"ok":true,"result":{...}} 或 {"id":2,"ok":false,"error":"..."}
//! 之所以用 JSON lines：Node 侧读写简单、可读、可调试；批量数据（向量矩阵）用 base64 传 float32，
//! 避免几 MB 的 JSON 数字数组。

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

const PROTOCOL: i64 = 1;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let version = env!("CARGO_PKG_VERSION");
    let mut buffer = String::new();
    let mut reader = stdin.lock();
    loop {
        buffer.clear();
        match reader.read_line(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let line = buffer.trim();
        if line.is_empty() {
            continue;
        }
        let id = request_id(line);
        let payload: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                respond(&mut stdout, id, Err(format!("invalid json: {error}")));
                continue;
            }
        };
        let command = payload.get("cmd").and_then(Value::as_str).unwrap_or("");
        let result = match command {
            "ping" => Ok(json!({ "version": version, "protocol": PROTOCOL })),
            "cosine" => cmd_cosine(&payload),
            "importance" => cmd_importance(&payload),
            "dedupe" => cmd_dedupe(&payload),
            "similar" => cmd_similar(&payload),
            "" => Err("missing cmd".to_string()),
            other => Err(format!("unknown cmd: {other}")),
        };
        respond(&mut stdout, id, result);
    }
}

fn request_id(line: &str) -> i64 {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_i64))
        .unwrap_or(0)
}

fn respond(stdout: &mut io::Stdout, id: i64, result: Result<Value, String>) {
    let envelope = match result {
        Ok(value) => json!({ "id": id, "ok": true, "result": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    let _ = writeln!(stdout, "{envelope}");
    let _ = stdout.flush();
}

// ------------------------------------------------------------------ cosine --

fn cmd_cosine(payload: &Value) -> Result<Value, String> {
    let dim = payload.get("dim").and_then(Value::as_u64).ok_or("dim is required")? as usize;
    if dim == 0 {
        return Err("dim must be positive".into());
    }
    let count = payload.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
    let query = decode_floats(payload.get("queryB64").and_then(Value::as_str), dim)?;
    let matrix = decode_floats(payload.get("matrixB64").and_then(Value::as_str), dim * count)?;
    let query_norm = norm(&query);
    if query_norm == 0.0 {
        return Ok(json!({ "scores": vec![0.0_f32; count] }));
    }
    let scores = if count >= 32 {
        parallel_cosine(&query, query_norm, &matrix, dim, count)
    } else {
        let mut scores = Vec::with_capacity(count);
        for index in 0..count {
            scores.push(cosine_at(&query, query_norm, &matrix, dim, index));
        }
        scores
    };
    Ok(json!({ "scores": scores, "count": count, "dim": dim }))
}

fn decode_floats(encoded: Option<&str>, expected: usize) -> Result<Vec<f32>, String> {
    let text = encoded.ok_or("base64 payload is required")?;
    let bytes = BASE64.decode(text.as_bytes()).map_err(|error| format!("base64 decode failed: {error}"))?;
    if bytes.len() != expected * 4 {
        return Err(format!(
            "vector payload size mismatch: expected {} floats, got {} bytes",
            expected,
            bytes.len()
        ));
    }
    let mut out = Vec::with_capacity(expected);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(out)
}

fn norm(vector: &[f32]) -> f32 {
    vector.iter().map(|value| value * value).sum::<f32>().sqrt()
}

fn cosine_at(query: &[f32], query_norm: f32, matrix: &[f32], dim: usize, index: usize) -> f32 {
    let base = index * dim;
    let candidate = &matrix[base..base + dim];
    let mut dot = 0.0_f32;
    let mut candidate_norm = 0.0_f32;
    for offset in 0..dim {
        let left = query[offset];
        let right = candidate[offset];
        dot += left * right;
        candidate_norm += right * right;
    }
    let denominator = query_norm * candidate_norm.sqrt();
    if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    }
}

/// 大矩阵分块到多个线程：每块独立计算，最后按块序号拼回去。
fn parallel_cosine(query: &[f32], query_norm: f32, matrix: &[f32], dim: usize, count: usize) -> Vec<f32> {
    let threads = std::thread::available_parallelism().map(|value| value.get()).unwrap_or(4).min(8);
    let chunk = (count + threads - 1) / threads;
    let mut results: Vec<Vec<f32>> = Vec::new();
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for thread_index in 0..threads {
            let start = thread_index * chunk;
            if start >= count {
                break;
            }
            let end = (start + chunk).min(count);
            let query = query;
            let matrix = matrix;
            handles.push(scope.spawn(move || {
                let mut scores = Vec::with_capacity(end - start);
                for index in start..end {
                    scores.push(cosine_at(query, query_norm, matrix, dim, index));
                }
                scores
            }));
        }
        for handle in handles {
            results.push(handle.join().unwrap_or_default());
        }
    });
    results.into_iter().flatten().collect()
}

// -------------------------------------------------------------- importance --

fn cmd_importance(payload: &Value) -> Result<Value, String> {
    let now = payload.get("now").and_then(Value::as_f64).unwrap_or(0.0);
    let items = payload.get("items").and_then(Value::as_array).ok_or("items is required")?;
    let mut scores = Vec::with_capacity(items.len());
    for item in items {
        let created = item.get("createdAt").and_then(Value::as_f64).unwrap_or(now);
        let last_access = item.get("lastAccessAt").and_then(Value::as_f64).unwrap_or(created);
        let access_count = item.get("accessCount").and_then(Value::as_f64).unwrap_or(0.0);
        let related_count = item.get("relatedCount").and_then(Value::as_f64).unwrap_or(0.0);
        let age_days = ((now - last_access).max(0.0)) / 86_400.0;
        let created_days = ((now - created).max(0.0)) / 86_400.0;
        // 时间衰减：指数衰减，半衰期 30 天；同时考虑创建时长避免新条目永远最高。
        let decay = (-(age_days / 30.0)).exp() * 0.7 + (-(created_days / 90.0)).exp() * 0.3;
        let frequency = (access_count / 10.0).min(1.0);
        let association = (related_count / 20.0).min(1.0);
        let score = decay * 0.4 + frequency * 0.4 + association * 0.2;
        scores.push(score as f32);
    }
    Ok(json!({ "scores": scores }))
}

// ----------------------------------------------------------------- dedupe --

fn cmd_dedupe(payload: &Value) -> Result<Value, String> {
    let threshold = payload.get("threshold").and_then(Value::as_f64).unwrap_or(0.82);
    let items = payload.get("items").and_then(Value::as_array).ok_or("items is required")?;
    let mut sets: Vec<(String, HashSet<String>)> = Vec::with_capacity(items.len());
    for item in items {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let tokens = item
            .get("tokens")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|token| token.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        sets.push((id, tokens));
    }
    // 倒排：token → 条目下标；只在共享 token 的候选对里算精确 Jaccard。
    let mut postings: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, (_, tokens)) in sets.iter().enumerate() {
        for token in tokens {
            postings.entry(token.as_str()).or_default().push(index);
        }
    }
    let mut candidates: HashSet<(usize, usize)> = HashSet::new();
    for indices in postings.values() {
        if indices.len() < 2 || indices.len() > 200 {
            continue;
        }
        for left in 0..indices.len() {
            for right in (left + 1)..indices.len() {
                let a = indices[left].min(indices[right]);
                let b = indices[left].max(indices[right]);
                candidates.insert((a, b));
            }
        }
    }
    let mut pairs = Vec::new();
    for (left, right) in candidates {
        let score = jaccard(&sets[left].1, &sets[right].1);
        if score >= threshold {
            pairs.push(json!({ "a": sets[left].0, "b": sets[right].0, "score": score }));
        }
    }
    Ok(json!({ "pairs": pairs, "scanned": sets.len() }))
}

fn cmd_similar(payload: &Value) -> Result<Value, String> {
    let tokens: HashSet<String> = payload
        .get("tokens")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|token| token.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let candidates = payload
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or("candidates is required")?;
    let mut out = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let id = candidate.get("id").and_then(Value::as_str).unwrap_or("");
        let other: HashSet<String> = candidate
            .get("tokens")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|token| token.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        out.push(json!({ "id": id, "score": jaccard(&tokens, &other) }));
    }
    Ok(json!({ "scores": out }))
}

fn jaccard(left: &HashSet<String>, right: &HashSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let (small, large) = if left.len() <= right.len() { (left, right) } else { (right, left) };
    let mut shared = 0usize;
    for token in small {
        if large.contains(token) {
            shared += 1;
        }
    }
    shared as f64 / (left.len() + right.len() - shared) as f64
}
