//go:build integration

package multirail

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

type toxiproxyToxic struct {
	Name       string         `json:"name"`
	Type       string         `json:"type"`
	Stream     string         `json:"stream"`
	Toxicity   float64        `json:"toxicity"`
	Attributes map[string]int `json:"attributes,omitempty"`
}

func toxiproxyURL(t *testing.T) string {
	t.Helper()
	value := strings.TrimRight(os.Getenv("UMOJA_TEST_TOXIPROXY_URL"), "/")
	if value == "" {
		t.Skip("UMOJA_TEST_TOXIPROXY_URL is not set")
	}
	return value
}

func setToxic(t *testing.T, baseURL, proxy, name, toxicType string) {
	t.Helper()
	toxic := toxiproxyToxic{Name: name, Type: toxicType, Stream: "downstream", Toxicity: 1}
	if toxicType == "timeout" {
		toxic.Attributes = map[string]int{"timeout": 60000}
	}
	payload, _ := json.Marshal(toxic)
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/proxies/%s/toxics", baseURL, proxy), strings.NewReader(string(payload)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("create toxic status=%s", response.Status)
	}
}

func clearToxic(t *testing.T, baseURL, proxy, name string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/proxies/%s/toxics/%s", baseURL, proxy, name), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		t.Fatalf("delete toxic status=%s", response.Status)
	}
}

func TestCrossReplicaClaimFailsClosedDuringToxiproxyPartition(t *testing.T) {
	proxyURL := toxiproxyURL(t)
	directDSN := os.Getenv("UMOJA_TEST_DATABASE_DIRECT_URL")
	proxyDSN := os.Getenv("UMOJA_TEST_DATABASE_URL")
	if directDSN == "" || proxyDSN == "" {
		t.Skip("UMOJA_TEST_DATABASE_DIRECT_URL and UMOJA_TEST_DATABASE_URL are required")
	}
	ctx := context.Background()
	direct, err := sql.Open("postgres", directDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer direct.Close()
	if err := direct.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	key := "toxiproxy-partition-" + time.Now().UTC().Format("20060102150405.000000000")
	payload := []byte(`{"sequenceId":"toxiproxy-partition"}`)
	state := UnknownState{Intent: Intent{ID: key, IdempotencyKey: key, Payload: payload}, PrimaryRail: "yellow_card", ObservedStatus: Unknown, NextAttemptAt: time.Now().UTC()}
	seedStore := &PostgresUnknownStateStore{DB: direct, LeaseDuration: time.Minute}
	defer func() {
		_, _ = direct.ExecContext(ctx, `DELETE FROM provider_reconciliation_decision WHERE idempotency_key=$1`, key)
		_, _ = direct.ExecContext(ctx, `DELETE FROM provider_unknown_reconciliation WHERE idempotency_key=$1`, key)
	}()
	if err := seedStore.EnqueueUnknown(ctx, state); err != nil {
		t.Fatal(err)
	}

	instanceA, err := sql.Open("postgres", proxyDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer instanceA.Close()
	instanceB, err := sql.Open("postgres", proxyDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer instanceB.Close()
	if err := instanceA.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	if err := instanceB.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	setToxic(t, proxyURL, "postgres", "partition", "timeout")
	partitionActive := true
	defer func() {
		if partitionActive {
			clearToxic(t, proxyURL, "postgres", "partition")
		}
	}()

	stores := []*PostgresUnknownStateStore{{DB: instanceA, LeaseDuration: time.Minute}, {DB: instanceB, LeaseDuration: time.Minute}}
	var wg sync.WaitGroup
	errs := make(chan error, len(stores))
	for _, store := range stores {
		wg.Add(1)
		go func(s *PostgresUnknownStateStore) {
			defer wg.Done()
			claimCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
			defer cancel()
			_, claimed, claimErr := s.Claim(claimCtx, key, time.Now().UTC())
			if claimErr == nil || claimed {
				errs <- fmt.Errorf("partitioned claim unexpectedly succeeded: claimed=%v err=%v", claimed, claimErr)
			} else {
				errs <- nil
			}
		}(store)
	}
	wg.Wait()
	close(errs)
	for claimErr := range errs {
		if claimErr != nil {
			t.Fatal(claimErr)
		}
	}
	clearToxic(t, proxyURL, "postgres", "partition")
	partitionActive = false

	results := make(chan bool, len(stores))
	for _, store := range stores {
		wg.Add(1)
		go func(s *PostgresUnknownStateStore) {
			defer wg.Done()
			_, claimed, claimErr := s.Claim(ctx, key, time.Now().UTC())
			if claimErr != nil {
				t.Errorf("post-recovery claim error: %v", claimErr)
				return
			}
			results <- claimed
		}(store)
	}
	wg.Wait()
	close(results)
	claimedCount := 0
	for claimed := range results {
		if claimed {
			claimedCount++
		}
	}
	if claimedCount != 1 {
		t.Fatalf("post-recovery claimed instances=%d, want exactly one", claimedCount)
	}
}
