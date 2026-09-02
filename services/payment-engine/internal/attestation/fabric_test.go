package attestation

import (
	"context"
	"testing"
)

type gatewayMock struct {
	submitted   Request
	digest      string
	record      Record
	submitErr   error
	evaluateErr error
}

func (m *gatewayMock) SubmitAttestation(_ context.Context, r Request, digest string) (Record, error) {
	m.submitted = r
	m.digest = digest
	if m.submitErr != nil {
		return Record{}, m.submitErr
	}
	return m.record, nil
}
func (m *gatewayMock) EvaluateAttestation(_ context.Context, _ string) (Record, error) {
	if m.evaluateErr != nil {
		return Record{}, m.evaluateErr
	}
	return m.record, nil
}

func TestNewRequestAndAttestBindEvidenceDigest(t *testing.T) {
	gw := &gatewayMock{record: Record{AttestationID: "a-1", ReleaseSHA: "0123456789abcdef0123456789abcdef01234567", EvidenceID: "E-08", EvidenceSHA256: EvidenceDigest([]byte("evidence")), EvidenceURI: "evidence/run.json", EndorsementScope: "org-a-org-b"}}
	client, err := NewClient(gw)
	if err != nil {
		t.Fatal(err)
	}
	req, err := NewRequest("0123456789abcdef0123456789abcdef01234567", "E-08", "evidence/run.json", "org-a-org-b", []byte("evidence"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Attest(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	if gw.digest != EvidenceDigest(req.Evidence) || gw.submitted.ReleaseSHA != req.ReleaseSHA {
		t.Fatalf("digest/release binding missing: %#v %s", gw.submitted, gw.digest)
	}
}

func TestNewRequestRejectsInvalidInputs(t *testing.T) {
	cases := []Request{{}, {ReleaseSHA: "bad", EvidenceID: "E-01", EvidenceURI: "uri", EndorsementScope: "scope", Evidence: []byte("x")}, {ReleaseSHA: "0123456789abcdef0123456789abcdef01234567", EvidenceID: "E-01", EvidenceURI: "uri", EndorsementScope: "scope"}}
	for i, c := range cases {
		if _, err := NewRequest(c.ReleaseSHA, c.EvidenceID, c.EvidenceURI, c.EndorsementScope, c.Evidence); err == nil {
			t.Fatalf("case %d accepted", i)
		}
	}
}

func TestVerifyChecksFabricDigest(t *testing.T) {
	digest := EvidenceDigest([]byte("evidence"))
	gw := &gatewayMock{record: Record{AttestationID: "a-2", EvidenceSHA256: digest}}
	client, _ := NewClient(gw)
	ok, err := client.Verify(context.Background(), "a-2", digest)
	if err != nil || !ok {
		t.Fatalf("expected verified digest, ok=%v err=%v", ok, err)
	}
	ok, err = client.Verify(context.Background(), "a-2", EvidenceDigest([]byte("other")))
	if err != nil || ok {
		t.Fatalf("expected mismatch, ok=%v err=%v", ok, err)
	}
}

func TestFabricClientRequiresGateway(t *testing.T) {
	if _, err := NewClient(nil); err == nil {
		t.Fatal("nil gateway accepted")
	}
}
