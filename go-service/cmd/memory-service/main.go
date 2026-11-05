// memory-service —— dsh-memory-plugin 的 Go 服务层（架构文档里的"Go 高并发检索服务"）。
//
// 职责（与设计文档对齐）：
//   - 拥有 SQLite 持久化（纯 Go 驱动 modernc.org/sqlite，无需 cgo）
//   - FTS5 全文检索 + bm25 排序
//   - 关系图谱 BFS 遍历
//   - 语义向量余弦（向量表存在 SQLite）
//   - 本地 HTTP/JSON 接口（替代 gRPC，Node 侧零额外依赖）
//
// 启动后向 stdout 打一行握手 JSON，Node 控制层据此拿到端口：
//
//	{"port":52341,"pid":1234,"version":"0.1.0"}
//
// 参数：
//
//	-db      SQLite 路径
//	-token   请求鉴权 token（Node 生成后通过环境变量/参数传入）
//	-host    监听地址（默认 127.0.0.1）
//	-port    监听端口（默认 0 = 随机）
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"dsh-memory-service/internal/api"
	"dsh-memory-service/internal/store"
)

// Version 是服务版本。
const Version = "0.1.0"

func main() {
	dbPath := flag.String("db", envOr("MEMORY_DB", ""), "SQLite 数据库路径")
	token := flag.String("token", envOr("MEMORY_TOKEN", ""), "请求鉴权 token")
	host := flag.String("host", envOr("MEMORY_HOST", "127.0.0.1"), "监听地址")
	port := flag.Int("port", 0, "监听端口（0=随机）")
	flag.Parse()

	if *dbPath == "" {
		fmt.Fprintln(os.Stderr, "缺少 -db 参数")
		os.Exit(1)
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetOutput(os.Stderr)

	st, err := store.Open(*dbPath, func(format string, args ...any) { log.Printf(format, args...) })
	if err != nil {
		fmt.Fprintln(os.Stderr, "打开数据库失败:", err)
		os.Exit(1)
	}
	defer st.Close()

	server := api.New(st, Version)
	server.SetToken(*token)

	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", *host, *port))
	if err != nil {
		fmt.Fprintln(os.Stderr, "监听失败:", err)
		os.Exit(1)
	}
	actualPort := listener.Addr().(*net.TCPAddr).Port

	httpServer := &http.Server{Handler: server.Handler()}

	shutdown := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		httpServer.Shutdown(ctx)
	}
	server.SetShutdown(func() {
		shutdown()
	})

	// 握手：Node 读这一行拿到端口
	handshake, _ := json.Marshal(map[string]any{
		"port": actualPort, "pid": os.Getpid(), "version": Version, "db": *dbPath,
	})
	fmt.Println(string(handshake))
	os.Stdout.Sync()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		shutdown()
	}()

	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "服务失败:", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
