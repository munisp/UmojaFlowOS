package provider

import (
	"context"
	"errors"
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
