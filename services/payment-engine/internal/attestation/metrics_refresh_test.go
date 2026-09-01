package attestation

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

type refreshDriver struct{}

func (refreshDriver) Open(string) (driver.Conn, error) { return refreshConn{}, nil }

type refreshConn struct{}

func (refreshConn) Prepare(string) (driver.Stmt, error) { return nil, fmt.Errorf("not used") }
func (refreshConn) Close() error                        { return nil }
func (refreshConn) Begin() (driver.Tx, error)           { return nil, fmt.Errorf("not used") }
func (refreshConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return &refreshRows{rows: [][]driver.Value{{"pending", int64(4)}, {"running", int64(2)}, {"unknown", int64(3)}, {"complete", int64(8)}}}, nil
}
func (refreshConn) CheckNamedValue(*driver.NamedValue) error { return nil }

type refreshRows struct {
	rows  [][]driver.Value
	index int
}

func (*refreshRows) Columns() []string { return []string{"state", "count"} }
func (r *refreshRows) Close() error    { return nil }
func (r *refreshRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.index])
	r.index++
	return nil
}

func TestQueueDepthRefresherSynchronizesReplicaSnapshots(t *testing.T) {
	name := "umoja_refresh_" + time.Now().Format("150405.000000000")
	sql.Register(name, refreshDriver{})
	dbA, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	defer dbA.Close()
	dbB, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	defer dbB.Close()
	metricsA, metricsB := NewMetrics(), NewMetrics()
	var wg sync.WaitGroup
	for _, item := range []struct {
		db      *sql.DB
		metrics *Metrics
	}{{dbA, metricsA}, {dbB, metricsB}} {
		wg.Add(1)
		go func(db *sql.DB, metrics *Metrics) {
			defer wg.Done()
			if err := metrics.RefreshQueueDepth(context.Background(), db); err != nil {
				t.Errorf("refresh failed: %v", err)
			}
		}(item.db, item.metrics)
	}
	wg.Wait()
	for _, metrics := range []*Metrics{metricsA, metricsB} {
		if metrics.QueuePending.Load() != 4 || metrics.QueueRunning.Load() != 2 || metrics.QueueUnknown.Load() != 3 || metrics.QueueComplete.Load() != 8 {
			t.Fatalf("unexpected snapshot: pending=%d running=%d unknown=%d complete=%d", metrics.QueuePending.Load(), metrics.QueueRunning.Load(), metrics.QueueUnknown.Load(), metrics.QueueComplete.Load())
		}
	}
}
