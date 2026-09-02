package fencestore

import (
	"strings"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/reconciliation"
)

func TestCommandHashExcludesSignatureAndIsDeterministic(t *testing.T) {
	command := reconciliation.FenceCommand{
		CommandID:    "command-001",
		Action:       reconciliation.FenceActionFence,
		Reason:       "OPA retry exhaustion",
		Environment:  "staging",
		SourceAlerts: []string{"UmojaOPARetryExhaustion"},
		IssuedAt:     time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC),
		ExpiresAt:    time.Date(2026, 9, 2, 12, 5, 0, 0, time.UTC),
		Nonce:        "0123456789abcdef",
		Signer:       "bridge",
		Signature:    "signature-one",
	}
	first, payload, err := commandHash(command)
	if err != nil {
		t.Fatal(err)
	}
	command.Signature = "signature-two"
	second, _, err := commandHash(command)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("signature changed command hash: %s != %s", first, second)
	}
	if strings.Contains(string(payload), "signature-one") {
		t.Fatal("canonical payload must exclude signature material")
	}
	if len(first) != 64 {
		t.Fatalf("hash length=%d, want 64", len(first))
	}
}
