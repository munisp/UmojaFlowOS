package attestation

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeterministicAttestationIDStableAndBound(t *testing.T) {
	base := DeterministicAttestationID(strings.Repeat("a", 40), "E-01", strings.Repeat("b", 64))
	if base == "" || len(base) != 64 {
		t.Fatalf("unexpected ID %q", base)
	}
	if base != DeterministicAttestationID(strings.Repeat("a", 40), "E-01", strings.Repeat("b", 64)) {
		t.Fatal("ID is not stable")
	}
	if base == DeterministicAttestationID(strings.Repeat("a", 40), "E-02", strings.Repeat("b", 64)) {
		t.Fatal("ID is not bound to evidence ID")
	}
}

func TestFileEvidenceLoaderRejectsNonFileAndLoadsBoundedEvidence(t *testing.T) {
	loader := FileEvidenceLoader{}
	if _, err := loader.Load(context.Background(), "s3://bucket/evidence.json"); err == nil {
		t.Fatal("accepted non-file evidence URI")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "evidence.json")
	if err := os.WriteFile(path, []byte("evidence"), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := loader.Load(context.Background(), "file://"+path)
	if err != nil || string(data) != "evidence" {
		t.Fatalf("load data=%q err=%v", data, err)
	}
}

func TestWorkerValidationFailsClosed(t *testing.T) {
	worker := &Worker{PollInterval: time.Second, RetryDelay: time.Second, Now: time.Now}
	if err := worker.validate(); err == nil {
		t.Fatal("accepted incomplete worker")
	}
}
