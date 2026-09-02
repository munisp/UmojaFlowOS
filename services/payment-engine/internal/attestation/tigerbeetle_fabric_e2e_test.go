package attestation

import (
	"context"
	"errors"
	"sync"
	"testing"
)

type simulatedLedger struct {
	mu       sync.Mutex
	balances map[uint64]int64
	posts    map[uint64]int
}

func newSimulatedLedger() *simulatedLedger {
	return &simulatedLedger{balances: map[uint64]int64{}, posts: map[uint64]int{}}
}
func (l *simulatedLedger) post(id, debit, credit uint64, amount int64) error {
	if debit == credit || amount <= 0 {
		return errors.New("invalid double-entry transfer")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.posts[id] > 0 {
		return errors.New("duplicate ledger transfer")
	}
	l.balances[debit] -= amount
	l.balances[credit] += amount
	l.posts[id]++
	return nil
}
func (l *simulatedLedger) balanced() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	var total int64
	for _, v := range l.balances {
		total += v
	}
	return total == 0
}

type byzantineGateway struct {
	mode    string
	mu      sync.Mutex
	submits int
	record  Record
}

func (g *byzantineGateway) SubmitAttestation(_ context.Context, req Request, digest string) (Record, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.submits++
	if g.mode == "timeout" {
		return Record{}, context.DeadlineExceeded
	}
	if g.mode == "error" {
		return Record{}, errors.New("gateway unavailable")
	}
	if g.mode == "wrong-digest" {
		return Record{AttestationID: "att-1", ReleaseSHA: req.ReleaseSHA, EvidenceID: req.EvidenceID, EvidenceSHA256: EvidenceDigest([]byte("wrong"))}, nil
	}
	g.record = Record{AttestationID: "att-1", ReleaseSHA: req.ReleaseSHA, EvidenceID: req.EvidenceID, EvidenceSHA256: digest, EvidenceURI: req.EvidenceURI, EndorsementScope: req.EndorsementScope}
	return g.record, nil
}
func (g *byzantineGateway) EvaluateAttestation(_ context.Context, _ string) (Record, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.mode == "timeout" || g.mode == "error" {
		return Record{}, errors.New("gateway unavailable")
	}
	return g.record, nil
}

func TestTigerBeetleFabricEndToEndByzantineFaults(t *testing.T) {
	cases := []struct {
		name, mode string
		wantErr    bool
	}{{"healthy", "", false}, {"wrong digest", "wrong-digest", true}, {"gateway timeout", "timeout", true}, {"gateway unavailable", "error", true}}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ledger := newSimulatedLedger()
			gateway := &byzantineGateway{mode: tc.mode}
			client, _ := NewClient(gateway)
			req, _ := NewRequest("0123456789abcdef0123456789abcdef01234567", "E-06", "evidence/E-06.json", "Org1MSP-Org2MSP", []byte("evidence"))
			if err := ledger.post(77, 1001, 2001, 500); err != nil {
				t.Fatal(err)
			}
			_, err := client.Attest(context.Background(), req)
			if (err != nil) != tc.wantErr {
				t.Fatalf("attestation error=%v wantErr=%v", err, tc.wantErr)
			}
			if !ledger.balanced() {
				t.Fatal("double-entry invariant broken")
			}
			if gateway.submits != 1 {
				t.Fatalf("expected exactly one submission attempt, got %d", gateway.submits)
			}
			if tc.wantErr {
				if _, err := client.Attest(context.Background(), req); err == nil {
					t.Fatal("blind retry unexpectedly accepted")
				}
				if gateway.submits != 2 {
					t.Fatalf("expected explicit second call in test, got %d", gateway.submits)
				}
			}
		})
	}
}
