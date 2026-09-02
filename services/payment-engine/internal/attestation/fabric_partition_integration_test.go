package attestation

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type partitionGateway struct {
	mu        sync.Mutex
	partition atomic.Bool
	submits   atomic.Int32
	record    Record
}

func (g *partitionGateway) SubmitAttestation(ctx context.Context, req Request, digest string) (Record, error) {
	g.submits.Add(1)
	if g.partition.Load() {
		return Record{}, context.DeadlineExceeded
	}
	select {
	case <-ctx.Done():
		return Record{}, ctx.Err()
	default:
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.record = Record{AttestationID: "attestation-1", ReleaseSHA: req.ReleaseSHA, EvidenceID: req.EvidenceID, EvidenceSHA256: digest, EvidenceURI: req.EvidenceURI, EndorsementScope: req.EndorsementScope}
	return g.record, nil
}
func (g *partitionGateway) EvaluateAttestation(ctx context.Context, id string) (Record, error) {
	if g.partition.Load() {
		return Record{}, errors.New("Fabric Gateway unavailable during partition")
	}
	if id == "" {
		return Record{}, errors.New("attestation ID required")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.record, nil
}

func TestFabricGatewayPartitionFailsClosedAndRecoversReadOnly(t *testing.T) {
	gw := &partitionGateway{}
	client, err := NewClient(gw)
	if err != nil {
		t.Fatal(err)
	}
	req, err := NewRequest("0123456789abcdef0123456789abcdef01234567", "E-06", "evidence/E-06.json", "Org1MSP-Org2MSP", []byte("evidence"))
	if err != nil {
		t.Fatal(err)
	}
	gw.partition.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := client.Attest(ctx, req); err == nil {
		t.Fatal("partitioned submit unexpectedly succeeded")
	}
	if _, err := client.Verify(context.Background(), "attestation-1", EvidenceDigest(req.Evidence)); err == nil {
		t.Fatal("partitioned read unexpectedly succeeded")
	}
	if gw.submits.Load() != 1 {
		t.Fatalf("expected one submission attempt, got %d", gw.submits.Load())
	}
	gw.partition.Store(false)
	gw.mu.Lock()
	gw.record = Record{AttestationID: "attestation-1", ReleaseSHA: req.ReleaseSHA, EvidenceID: req.EvidenceID, EvidenceSHA256: EvidenceDigest(req.Evidence), EvidenceURI: req.EvidenceURI, EndorsementScope: req.EndorsementScope}
	gw.mu.Unlock()
	ok, err := client.Verify(context.Background(), "attestation-1", EvidenceDigest(req.Evidence))
	if err != nil || !ok {
		t.Fatalf("recovery verify failed: ok=%v err=%v", ok, err)
	}
	if gw.submits.Load() != 1 {
		t.Fatalf("reconciliation caused duplicate submission: %d", gw.submits.Load())
	}
}

func TestFabricGatewayPartitionRejectsConcurrentBlindRetries(t *testing.T) {
	gw := &partitionGateway{}
	gw.partition.Store(true)
	client, _ := NewClient(gw)
	req, _ := NewRequest("0123456789abcdef0123456789abcdef01234567", "E-04", "evidence/E-04.json", "Org1MSP-Org2MSP", []byte("evidence"))
	var wg sync.WaitGroup
	var successes atomic.Int32
	workers := 100
	if raw := os.Getenv("FABRIC_PARTITION_WORKERS"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			t.Fatalf("invalid FABRIC_PARTITION_WORKERS: %q", raw)
		}
		workers = parsed
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := client.Attest(context.Background(), req); err == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 0 {
		t.Fatalf("partition accepted %d submissions", successes.Load())
	}
	if gw.submits.Load() != int32(workers) {
		t.Fatalf("expected each simulated caller to observe failure, got %d attempts", gw.submits.Load())
	}
}
