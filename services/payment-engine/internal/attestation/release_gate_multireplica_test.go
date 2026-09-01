package attestation

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestReleaseManifestGateMultiReplicaStartupAndWORMBinding(t *testing.T) {
	dir := t.TempDir()
	sigDir := filepath.Join(dir, "signatures")
	if err := os.Mkdir(sigDir, 0700); err != nil {
		t.Fatal(err)
	}
	release := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	content := []byte("shared-evidence")
	digest := sha256.Sum256(content)
	if err := os.WriteFile(filepath.Join(dir, "evidence.json"), content, 0600); err != nil {
		t.Fatal(err)
	}
	manifest := releaseManifest{ReleaseSHA: release, Environment: "staging", CreatedAt: "2026-09-01T00:00:00Z", Worm: releaseWorm{Bucket: "umoja-release-evidence", ObjectKeyPrefix: "releases/multireplica", ObjectLockMode: "COMPLIANCE", RetainUntil: "2027-09-01T00:00:00Z"}, Reconciliation: releaseReconciliation{RunID: "staging-multireplica-run"}, Artifacts: make([]releaseArtifact, 0, 9)}
	for i := 1; i <= 9; i++ {
		sha := hex.EncodeToString(make([]byte, 32))
		if i == 1 {
			sha = hex.EncodeToString(digest[:])
		}
		manifest.Artifacts = append(manifest.Artifacts, releaseArtifact{EvidenceID: "E-0" + string(rune('0'+i)), Path: "evidence.json", SHA256: sha, RunID: "run-20260901"})
	}
	roles := []string{"release_manager", "security_owner", "compliance_owner", "operations_owner"}
	for i, role := range roles {
		manifest.Approvals = append(manifest.Approvals, releaseApproval{Role: role, Subject: "replica-subject-" + string(rune('a'+i)), ReleaseSHA: release, ApprovedAt: "2026-09-01T00:00:00Z"})
	}
	canonical, err := canonicalJSON(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifestPath, canonical, 0600); err != nil {
		t.Fatal(err)
	}
	manifestDigest := sha256.Sum256(canonical)
	for _, approval := range manifest.Approvals {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		payload := append(append(append(append([]byte{}, canonical...), '\n'), []byte(approval.Role)...), '\n')
		payload = append(payload, []byte(approval.Subject)...)
		payload = append(payload, '\n')
		payload = append(payload, []byte(release)...)
		sidecar := approvalSidecar{Role: approval.Role, Subject: approval.Subject, ReleaseSHA: release, ManifestSHA256: hex.EncodeToString(manifestDigest[:]), Algorithm: "Ed25519", PublicKey: base64.StdEncoding.EncodeToString(pub), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))}
		data, _ := json.Marshal(sidecar)
		if err := os.WriteFile(filepath.Join(sigDir, approval.Role+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	item := QueueItem{ReleaseSHA: release, EvidenceID: "E-01", PayloadDigest: hex.EncodeToString(digest[:])}
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			gate, err := NewReleaseManifestGate(manifestPath, sigDir, "staging", "umoja-release-evidence")
			if err != nil {
				errs <- err
				return
			}
			errs <- gate.Verify(context.Background(), item)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("valid replica gate rejected: %v", err)
		}
	}
	for i := 0; i < 3; i++ {
		gate, err := NewReleaseManifestGate(manifestPath, sigDir, "staging", "wrong-bucket")
		if err != nil {
			t.Fatal(err)
		}
		if err := gate.Verify(context.Background(), item); err == nil {
			t.Fatal("invalid WORM bucket accepted by replica gate")
		}
	}
}
