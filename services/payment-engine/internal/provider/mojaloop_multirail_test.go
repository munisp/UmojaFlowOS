package provider

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

type testMojaloopClient struct {
	calls    atomic.Int32
	last     MojaloopInstruction
	status   MojaloopTransferStatus
	queryErr error
}

func (c *testMojaloopClient) SubmitTransfer(_ context.Context, instruction MojaloopInstruction) (string, error) {
	c.calls.Add(1)
	c.last = instruction
	return instruction.InstructionID, nil
}

func (c *testMojaloopClient) QueryTransfer(_ context.Context, instruction MojaloopInstruction) (MojaloopTransferStatus, error) {
	if c.queryErr != nil {
		return MojaloopTransferStatus{}, c.queryErr
	}
	if c.status.TransferID == "" {
		c.status.TransferID = instruction.InstructionID
	}
	return c.status, nil
}

type yellowCardFailureForMojaloop struct {
	queryStatus multirail.Submission
	queryErr    error
}

func (r yellowCardFailureForMojaloop) Name() string { return "yellow_card" }
func (r yellowCardFailureForMojaloop) Submit(context.Context, multirail.Intent) (multirail.Submission, error) {
	return multirail.Submission{}, errors.New("Yellow Card network timeout")
}
func (r yellowCardFailureForMojaloop) Query(context.Context, multirail.Intent) (multirail.Submission, error) {
	return r.queryStatus, r.queryErr
}

func mojaloopIntentPayload(id string) []byte {
	return []byte(`{"instructionId":"` + id + `","corridor":"NIGERIA_NGN","amount":"100.25","currency":"NGN","payerFsp":"umojaflowos-ng","payeeFsp":"licensed-counterparty","expiration":"2030-01-01T00:00:00Z","ilpPacket":"TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","condition":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`)
}

func TestCoordinatorFallsBackToMojaloopOnlyAfterYellowCardProvesNonSubmission(t *testing.T) {
	id := "019875da-8fd5-7edb-98ad-57b1744d1c8a"
	intent := multirail.Intent{ID: id, IdempotencyKey: id, Payload: mojaloopIntentPayload(id)}
	client := &testMojaloopClient{}
	mojaloopRail, err := NewMojaloopRail(client, nil)
	if err != nil {
		t.Fatal(err)
	}
	primary := yellowCardFailureForMojaloop{queryStatus: multirail.Submission{Status: multirail.Failed, RetryableWithoutBusinessEffect: true, Reason: "provider confirmed no submission"}}
	result, err := multirail.NewCoordinator().Execute(context.Background(), intent, primary, mojaloopRail)
	if err != nil {
		t.Fatal(err)
	}
	if result.Rail != "mojaloop" || result.Status != multirail.Pending || result.ProviderRef != id {
		t.Fatalf("result=%+v", result)
	}
	if client.calls.Load() != 1 {
		t.Fatalf("Mojaloop calls=%d, want 1", client.calls.Load())
	}
	if client.last.InstructionID != id || client.last.Currency != "NGN" {
		t.Fatalf("instruction=%+v", client.last)
	}
}

func TestCoordinatorNeverFallsBackToMojaloopFromYellowCardUnknown(t *testing.T) {
	id := "019875da-8fd5-7edb-98ad-57b1744d1c8a"
	intent := multirail.Intent{ID: id, IdempotencyKey: id, Payload: mojaloopIntentPayload(id)}
	client := &testMojaloopClient{}
	mojaloopRail, err := NewMojaloopRail(client, nil)
	if err != nil {
		t.Fatal(err)
	}
	primary := yellowCardFailureForMojaloop{queryStatus: multirail.Submission{Status: multirail.Unknown}}
	_, err = multirail.NewCoordinator().Execute(context.Background(), intent, primary, mojaloopRail)
	if !errors.Is(err, multirail.ErrUnknownOutcome) {
		t.Fatalf("error=%v, want ErrUnknownOutcome", err)
	}
	if client.calls.Load() != 0 {
		t.Fatalf("Mojaloop calls=%d, want 0", client.calls.Load())
	}
}

func TestMojaloopInstructionFromIntentRejectsExpiredInstruction(t *testing.T) {
	id := "019875da-8fd5-7edb-98ad-57b1744d1c8a"
	intent := multirail.Intent{IdempotencyKey: id, Payload: []byte(`{"instructionId":"` + id + `","corridor":"NIGERIA_NGN","amount":"1","currency":"NGN","payerFsp":"a","payeeFsp":"b","expiration":"` + time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano) + `","ilpPacket":"packet","condition":"condition"}`)}
	if _, err := MojaloopInstructionFromIntent(intent); err == nil {
		t.Fatal("expired instruction was accepted")
	}
}

func TestMojaloopStatus404KeepsCoordinatorFailClosed(t *testing.T) {
	id := "019875da-8fd5-7edb-98ad-57b1744d1c8a"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/transfers":
			w.WriteHeader(http.StatusInternalServerError)
		case r.Method == http.MethodGet && r.URL.Path == "/transfers/"+id:
			w.WriteHeader(http.StatusNotFound)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	client, err := NewFSPIOPMojaloopClient(MojaloopConfig{
		BaseURL:               server.URL,
		SourceFSP:             "umojaflowos-ng",
		Signer:                &fixedMojaloopSigner{signature: "signature"},
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	primary, err := NewMojaloopRail(client, nil)
	if err != nil {
		t.Fatal(err)
	}
	secondary := &fallbackProbeRail{}
	intent := multirail.Intent{ID: id, IdempotencyKey: id, Payload: mojaloopIntentPayload(id)}
	_, err = multirail.NewCoordinator().Execute(context.Background(), intent, primary, secondary)
	if !errors.Is(err, multirail.ErrUnknownOutcome) {
		t.Fatalf("error=%v, want ErrUnknownOutcome", err)
	}
	if secondary.calls.Load() != 0 {
		t.Fatalf("secondary calls=%d, want 0", secondary.calls.Load())
	}
}

type fallbackProbeRail struct{ calls atomic.Int32 }

func (r *fallbackProbeRail) Name() string { return "fallback-probe" }
func (r *fallbackProbeRail) Submit(context.Context, multirail.Intent) (multirail.Submission, error) {
	r.calls.Add(1)
	return multirail.Submission{Status: multirail.Submitted}, nil
}
func (r *fallbackProbeRail) Query(context.Context, multirail.Intent) (multirail.Submission, error) {
	return multirail.Submission{Status: multirail.Unknown}, multirail.ErrUnknownOutcome
}
