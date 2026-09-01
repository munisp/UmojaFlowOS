package attestation

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type contentionDriver struct {
	hold      time.Duration
	active    atomic.Int64
	maxActive atomic.Int64
}

func (d *contentionDriver) Open(string) (driver.Conn, error) { return &contentionConn{driver: d}, nil }

type contentionConn struct{ driver *contentionDriver }

func (c *contentionConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements not used")
}
func (c *contentionConn) Close() error              { return nil }
func (c *contentionConn) Begin() (driver.Tx, error) { return nil, errors.New("transactions not used") }
func (c *contentionConn) ExecContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Result, error) {
	active := c.driver.active.Add(1)
	for {
		previous := c.driver.maxActive.Load()
		if active <= previous || c.driver.maxActive.CompareAndSwap(previous, active) {
			break
		}
	}
	defer c.driver.active.Add(-1)
	timer := time.NewTimer(c.driver.hold)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return driver.RowsAffected(1), nil
	}
}
func (c *contentionConn) CheckNamedValue(*driver.NamedValue) error { return nil }

func TestPostgresPoolContentionIsBoundedAndCancellationFailsClosed(t *testing.T) {
	driverName := "umoja_contention_" + time.Now().Format("150405.000000000")
	backend := &contentionDriver{hold: 25 * time.Millisecond}
	sql.Register(driverName, backend)
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)
	const workers = 100
	var wg sync.WaitGroup
	var canceled atomic.Int32
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
			defer cancel()
			if _, err := db.ExecContext(ctx, "queue claim"); errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				canceled.Add(1)
			}
		}()
	}
	wg.Wait()
	if max := backend.maxActive.Load(); max > 8 {
		t.Fatalf("pool exceeded MaxOpenConns: max_active=%d", max)
	}
	if canceled.Load() == 0 {
		t.Fatal("no canceled waiters observed under forced pool contention")
	}
	t.Logf("SIMULATED pool workers=%d max_open=8 max_active=%d canceled_waiters=%d", workers, backend.maxActive.Load(), canceled.Load())
}
