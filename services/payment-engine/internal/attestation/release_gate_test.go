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
	"testing"
)

func TestReleaseManifestGateValidatesFourSignedRolesAndArtifact(t *testing.T) {
	dir := t.TempDir()
	sigDir := filepath.Join(dir, "signatures")
	if err := os.Mkdir(sigDir, 0700); err != nil {
		t.Fatal(err)
	}
	release := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	data := []byte("e01-content")
	digest := sha256.Sum256(data)
	if err := os.WriteFile(filepath.Join(dir, "e01.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	roles := []string{"release_manager", "security_owner", "compliance_owner", "operations_owner"}
	manifest := releaseManifest{ReleaseSHA: release, Environment: "staging", CreatedAt: "2026-09-01T00:00:00Z", Worm: releaseWorm{Bucket: "umoja-release-evidence", ObjectKeyPrefix: "releases/example", ObjectLockMode: "COMPLIANCE", RetainUntil: "2027-09-01T00:00:00Z"}, Reconciliation: releaseReconciliation{RunID: "staging-reconciliation-example"}, Artifacts: make([]releaseArtifact, 0, 9)}
	for i := 1; i <= 9; i++ {
		id := "E-0" + string(rune('0'+i))
		sha := hex.EncodeToString(make([]byte, 32))
		if i == 1 {
			sha = hex.EncodeToString(digest[:])
		}
		manifest.Artifacts = append(manifest.Artifacts, releaseArtifact{EvidenceID: id, Path: "e01.json", SHA256: sha, RunID: "run"})
	}
	manifest.Approvals = make([]releaseApproval, 0, 4)
	for i, role := range roles {
		manifest.Approvals = append(manifest.Approvals, releaseApproval{Role: role, Subject: "subject-" + string(rune('a'+i)), ReleaseSHA: release, ApprovedAt: "2026-09-01T00:00:00Z"})
	}
	canonical, err := canonicalJSON(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), canonical, 0600); err != nil {
		t.Fatal(err)
	}
	md := sha256.Sum256(canonical)
	for _, approval := range manifest.Approvals {
		pub, priv, _ := ed25519.GenerateKey(rand.Reader)
		payload := append(append(append(append([]byte{}, canonical...), '\n'), []byte(approval.Role)...), '\n')
		payload = append(payload, []byte(approval.Subject)...)
		payload = append(payload, '\n')
		payload = append(payload, []byte(release)...)
		sidecar := approvalSidecar{Role: approval.Role, Subject: approval.Subject, ReleaseSHA: release, ManifestSHA256: hex.EncodeToString(md[:]), Algorithm: "Ed25519", PublicKey: base64.StdEncoding.EncodeToString(pub), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))}
		encoded, _ := json.Marshal(sidecar)
		if err := os.WriteFile(filepath.Join(sigDir, approval.Role+".json"), encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
	gate, err := NewReleaseManifestGate(filepath.Join(dir, "manifest.json"), sigDir, "staging", "umoja-release-evidence")
	if err != nil {
		t.Fatal(err)
	}
	item := QueueItem{ReleaseSHA: release, EvidenceID: "E-01", PayloadDigest: hex.EncodeToString(digest[:])}
	if err := gate.Verify(context.Background(), item); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
}

func TestReleaseManifestGateRejectsTamperedSignatureAndArtifact(t *testing.T) {
	gate, err := NewReleaseManifestGate("/missing/manifest.json", "/missing/signatures", "staging", "umoja-release-evidence")
	if err != nil {
		t.Fatal(err)
	}
	if err := gate.Verify(context.Background(), QueueItem{ReleaseSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", EvidenceID: "E-01", PayloadDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}); err == nil {
		t.Fatal("missing manifest was accepted")
	}
}
