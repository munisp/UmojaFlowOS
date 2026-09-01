package attestation

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var ErrReleaseManifestGate = errors.New("signed release manifest prerequisite is not satisfied")

var requiredApprovalRoles = map[string]struct{}{
	"release_manager": {}, "security_owner": {}, "compliance_owner": {}, "operations_owner": {},
}

type ReleaseManifestGate struct {
	ManifestPath  string
	SignaturesDir string
	Environment   string
	WormBucket    string
}

type releaseManifest struct {
	ReleaseSHA     string                `json:"release_sha"`
	Environment    string                `json:"environment"`
	CreatedAt      string                `json:"created_at"`
	Artifacts      []releaseArtifact     `json:"artifacts"`
	Approvals      []releaseApproval     `json:"approvals"`
	Worm           releaseWorm           `json:"worm"`
	Reconciliation releaseReconciliation `json:"reconciliation"`
}
type releaseArtifact struct {
	EvidenceID string `json:"evidence_id"`
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	RunID      string `json:"run_id"`
}
type releaseApproval struct {
	Role       string `json:"role"`
	Subject    string `json:"subject"`
	ReleaseSHA string `json:"release_sha"`
	ApprovedAt string `json:"approved_at"`
}
type releaseWorm struct {
	Bucket          string `json:"bucket"`
	ObjectKeyPrefix string `json:"object_key_prefix"`
	ObjectLockMode  string `json:"object_lock_mode"`
	RetainUntil     string `json:"retain_until"`
}
type releaseReconciliation struct {
	RunID string `json:"run_id"`
}
type approvalSidecar struct {
	Role           string `json:"role"`
	Subject        string `json:"subject"`
	ReleaseSHA     string `json:"release_sha"`
	ManifestSHA256 string `json:"manifest_sha256"`
	Algorithm      string `json:"algorithm"`
	PublicKey      string `json:"public_key"`
	Signature      string `json:"signature"`
}

func NewReleaseManifestGate(manifestPath, signaturesDir, environment, wormBucket string) (*ReleaseManifestGate, error) {
	if strings.TrimSpace(manifestPath) == "" || strings.TrimSpace(signaturesDir) == "" || strings.TrimSpace(environment) == "" || strings.TrimSpace(wormBucket) == "" {
		return nil, fmt.Errorf("%w: manifest, signatures directory, and environment are required", ErrReleaseManifestGate)
	}
	return &ReleaseManifestGate{ManifestPath: manifestPath, SignaturesDir: signaturesDir, Environment: environment, WormBucket: wormBucket}, nil
}

func (g *ReleaseManifestGate) Verify(ctx context.Context, item QueueItem) error {
	if g == nil {
		return fmt.Errorf("%w: gate is not configured", ErrReleaseManifestGate)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	canonical, manifest, err := g.readAndValidateManifest(item)
	if err != nil {
		return err
	}
	manifestDigest := sha256.Sum256(canonical)
	if err := g.verifyApprovals(manifest, canonical, hex.EncodeToString(manifestDigest[:])); err != nil {
		return err
	}
	var artifact *releaseArtifact
	for i := range manifest.Artifacts {
		if manifest.Artifacts[i].EvidenceID == item.EvidenceID {
			artifact = &manifest.Artifacts[i]
			break
		}
	}
	if artifact == nil || !constantTimeEqual(artifact.SHA256, item.PayloadDigest) {
		return fmt.Errorf("%w: manifest artifact binding mismatch for %s", ErrReleaseManifestGate, item.EvidenceID)
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(g.ManifestPath), filepath.Clean(artifact.Path)))
	if err != nil {
		return fmt.Errorf("%w: read artifact %s: %v", ErrReleaseManifestGate, item.EvidenceID, err)
	}
	sum := sha256.Sum256(data)
	if !constantTimeEqual(hex.EncodeToString(sum[:]), artifact.SHA256) {
		return fmt.Errorf("%w: artifact hash mismatch for %s", ErrReleaseManifestGate, item.EvidenceID)
	}
	return nil
}

func (g *ReleaseManifestGate) readAndValidateManifest(item QueueItem) ([]byte, releaseManifest, error) {
	data, err := os.ReadFile(g.ManifestPath)
	if err != nil {
		return nil, releaseManifest{}, fmt.Errorf("%w: read manifest: %v", ErrReleaseManifestGate, err)
	}
	var manifest releaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, manifest, fmt.Errorf("%w: malformed manifest: %v", ErrReleaseManifestGate, err)
	}
	canonical, err := canonicalJSON(manifest)
	if err != nil {
		return nil, manifest, fmt.Errorf("%w: canonicalize manifest: %v", ErrReleaseManifestGate, err)
	}
	if len(manifest.ReleaseSHA) != 40 || !isLowerHex(manifest.ReleaseSHA) || manifest.Environment != g.Environment || !constantTimeEqual(manifest.ReleaseSHA, item.ReleaseSHA) || len(manifest.Artifacts) < 9 || len(manifest.Approvals) != 4 {
		return nil, manifest, fmt.Errorf("%w: manifest release, environment, artifact, or approval constraints failed", ErrReleaseManifestGate)
	}
	if _, err := time.Parse(time.RFC3339, manifest.CreatedAt); err != nil {
		return nil, manifest, fmt.Errorf("%w: invalid created_at", ErrReleaseManifestGate)
	}
	if manifest.Worm.Bucket != g.WormBucket || manifest.Worm.ObjectKeyPrefix == "" || strings.HasPrefix(manifest.Worm.ObjectKeyPrefix, "/") || strings.Contains(manifest.Worm.ObjectKeyPrefix, "..") || (manifest.Worm.ObjectLockMode != "COMPLIANCE" && manifest.Worm.ObjectLockMode != "GOVERNANCE") {
		return nil, manifest, fmt.Errorf("%w: WORM binding failed", ErrReleaseManifestGate)
	}
	retainUntil, err := time.Parse(time.RFC3339, manifest.Worm.RetainUntil)
	if err != nil || !retainUntil.After(time.Now().UTC()) {
		return nil, manifest, fmt.Errorf("%w: WORM retention timestamp is invalid or expired", ErrReleaseManifestGate)
	}
	if len(manifest.Reconciliation.RunID) < 8 {
		return nil, manifest, fmt.Errorf("%w: reconciliation run ID is missing or invalid", ErrReleaseManifestGate)
	}
	seen := map[string]bool{}
	for _, a := range manifest.Artifacts {
		if !strings.HasPrefix(a.EvidenceID, "E-0") || len(a.SHA256) != 64 || !isLowerHex(a.SHA256) || a.Path == "" || filepath.IsAbs(a.Path) || filepath.Clean(a.Path) != a.Path || strings.HasPrefix(a.Path, "..") || seen[a.EvidenceID] {
			return nil, manifest, fmt.Errorf("%w: invalid or duplicate artifact", ErrReleaseManifestGate)
		}
		seen[a.EvidenceID] = true
	}
	for i := 1; i <= 9; i++ {
		if !seen[fmt.Sprintf("E-%02d", i)] {
			return nil, manifest, fmt.Errorf("%w: missing E-%02d artifact", ErrReleaseManifestGate, i)
		}
	}
	return canonical, manifest, nil
}

func (g *ReleaseManifestGate) verifyApprovals(manifest releaseManifest, canonical []byte, manifestDigest string) error {
	seenRoles, seenSubjects := map[string]bool{}, map[string]bool{}
	failures := make([]string, 0)
	for _, a := range manifest.Approvals {
		if _, ok := requiredApprovalRoles[a.Role]; !ok || seenRoles[a.Role] || a.Subject == "" || seenSubjects[a.Subject] || !constantTimeEqual(a.ReleaseSHA, manifest.ReleaseSHA) {
			failures = append(failures, a.Role+": approval role, subject, or release binding failed")
			continue
		}
		if _, err := time.Parse(time.RFC3339, a.ApprovedAt); err != nil {
			failures = append(failures, a.Role+": invalid approval timestamp")
			continue
		}
		seenRoles[a.Role], seenSubjects[a.Subject] = true, true
		if err := g.verifyApprovalSidecar(a, manifest, canonical, manifestDigest); err != nil {
			failures = append(failures, a.Role+": "+err.Error())
		}
	}
	for role := range requiredApprovalRoles {
		if !seenRoles[role] {
			failures = append(failures, role+": missing approval")
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("%w: detached approval verification failed: %s", ErrReleaseManifestGate, strings.Join(failures, "; "))
	}
	return nil
}

func (g *ReleaseManifestGate) verifyApprovalSidecar(a releaseApproval, manifest releaseManifest, canonical []byte, manifestDigest string) error {
	sidecarData, err := os.ReadFile(filepath.Join(g.SignaturesDir, a.Role+".json"))
	if err != nil {
		return fmt.Errorf("missing signature sidecar")
	}
	var s approvalSidecar
	if json.Unmarshal(sidecarData, &s) != nil || s.Role != a.Role || s.Subject != a.Subject || !constantTimeEqual(s.ReleaseSHA, manifest.ReleaseSHA) || !constantTimeEqual(s.ManifestSHA256, manifestDigest) || s.Algorithm != "Ed25519" {
		return fmt.Errorf("invalid sidecar binding")
	}
	pub, err1 := base64.StdEncoding.DecodeString(s.PublicKey)
	sig, err2 := base64.StdEncoding.DecodeString(s.Signature)
	if err1 != nil || err2 != nil || len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("invalid signature encoding")
	}
	payload := append(append(append(append([]byte{}, canonical...), '\n'), []byte(a.Role)...), '\n')
	payload = append(payload, []byte(a.Subject)...)
	payload = append(payload, '\n')
	payload = append(payload, []byte(manifest.ReleaseSHA)...)
	if !ed25519.Verify(ed25519.PublicKey(pub), payload, sig) {
		return fmt.Errorf("signature verification failed")
	}
	return nil
}

func canonicalJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return marshalCanonical(value)
}

func marshalCanonical(value any) ([]byte, error) {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		for i := 1; i < len(keys); i++ {
			for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
				keys[j], keys[j-1] = keys[j-1], keys[j]
			}
		}
		var out []byte
		out = append(out, '{')
		for i, key := range keys {
			if i > 0 {
				out = append(out, ',')
			}
			encodedKey, _ := json.Marshal(key)
			out = append(out, encodedKey...)
			out = append(out, ':')
			encodedValue, err := marshalCanonical(v[key])
			if err != nil {
				return nil, err
			}
			out = append(out, encodedValue...)
		}
		return append(out, '}'), nil
	case []any:
		out := []byte{'['}
		for i, item := range v {
			if i > 0 {
				out = append(out, ',')
			}
			encoded, err := marshalCanonical(item)
			if err != nil {
				return nil, err
			}
			out = append(out, encoded...)
		}
		return append(out, ']'), nil
	default:
		return json.Marshal(v)
	}
}

func constantTimeEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func isLowerHex(v string) bool {
	if v == "" {
		return false
	}
	for _, r := range v {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}
