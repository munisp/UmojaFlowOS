package provider

import (
	"context"
	"testing"
)

func TestDisabledMojaloopClientFailsClosed(t *testing.T) {
	instruction := MojaloopInstruction{InstructionID: "instruction-1", Corridor: "NIGERIA_NGN", Amount: "100", Currency: "NGN"}
	if err := ValidateInstruction(instruction); err != nil {
		t.Fatal(err)
	}
	if _, err := (DisabledMojaloopClient{}).SubmitTransfer(context.Background(), instruction); err == nil {
		t.Fatal("disabled Mojaloop client accepted a transfer")
	}
}
