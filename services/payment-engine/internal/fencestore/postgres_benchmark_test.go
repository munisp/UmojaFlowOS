package fencestore

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

func BenchmarkPostgresFenceStoreConcurrentSequence(b *testing.B) {
	dsn := os.Getenv("UMOJA_FENCE_TEST_DATABASE_URL")
	if dsn == "" {
		b.Skip("UMOJA_FENCE_TEST_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	if err := db.PingContext(context.Background()); err != nil {
		b.Fatal(err)
	}
	environment := "bench-" + strings.ToLower(strings.ReplaceAll(b.Name(), "/", "-"))
	if _, err := db.Exec(`DELETE FROM settlement_fence_commands WHERE environment=$1`, environment); err != nil {
		b.Fatal(err)
	}
	defer db.Exec(`DELETE FROM settlement_fence_commands WHERE environment=$1`, environment)
	store := &PostgresStore{DB: db}
	var sequence atomic.Uint64
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			n := sequence.Add(1)
			command := integrationFenceCommand(environment, fmt.Sprintf("bench-%010d", n), "benchmark")
			if err := store.RecordFenceCommandContext(context.Background(), command, ""); err != nil {
				b.Errorf("insert: %v", err)
			}
		}
	})
	b.StopTimer()
	var rows, versions int
	if err := db.QueryRow(`SELECT count(*), count(DISTINCT fence_version) FROM settlement_fence_commands WHERE environment=$1`, environment).Scan(&rows, &versions); err != nil {
		b.Fatal(err)
	}
	if rows != int(sequence.Load()) || versions != rows {
		b.Fatalf("rows=%d versions=%d submitted=%d", rows, versions, sequence.Load())
	}
	b.ReportMetric(float64(rows), "commands")
	b.ReportMetric(float64(time.Second)/float64(time.Duration(b.Elapsed().Nanoseconds())/time.Duration(max(1, b.N))), "commands/sec")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
