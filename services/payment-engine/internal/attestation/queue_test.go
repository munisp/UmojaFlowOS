package attestation

import (
	"context"
	"testing"
	"time"
)

func TestAdmissionControllerBoundsConcurrencyAndReleases(t *testing.T) {
	admission, err := NewAdmissionController(2)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := admission.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	if err := admission.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if err := admission.Acquire(waitCtx); err == nil {
		t.Fatal("third concurrent Fabric call unexpectedly admitted")
	}
	admission.Release()
	if err := admission.Acquire(context.Background()); err != nil {
		t.Fatalf("admission did not recover after release: %v", err)
	}
	admission.Release()
	admission.Release()
}

func TestAdmissionControllerRejectsInvalidLimit(t *testing.T) {
	if _, err := NewAdmissionController(0); err == nil {
		t.Fatal("zero admission limit accepted")
	}
}
