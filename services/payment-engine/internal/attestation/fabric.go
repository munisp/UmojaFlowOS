package attestation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var releasePattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Request struct {
	ReleaseSHA       string
	EvidenceID       string
	EvidenceURI      string
	Evidence         []byte
	EndorsementScope string
}

type Record struct {
	AttestationID    string
	ReleaseSHA       string
	EvidenceID       string
	EvidenceSHA256   string
	EvidenceURI      string
	EndorsementScope string
}

type FabricGateway interface {
	SubmitAttestation(context.Context, Request, string) (Record, error)
	EvaluateAttestation(context.Context, string) (Record, error)
}

type Client struct{ gateway FabricGateway }

func NewClient(gateway FabricGateway) (*Client, error) {
	if gateway == nil {
		return nil, errors.New("Fabric gateway is required")
	}
	return &Client{gateway: gateway}, nil
}

func NewRequest(releaseSHA, evidenceID, evidenceURI, endorsementScope string, evidence []byte) (Request, error) {
	releaseSHA = strings.TrimSpace(releaseSHA)
	evidenceID = strings.TrimSpace(evidenceID)
	evidenceURI = strings.TrimSpace(evidenceURI)
	endorsementScope = strings.TrimSpace(endorsementScope)
	if !releasePattern.MatchString(releaseSHA) {
		return Request{}, errors.New("release SHA must be 40 lowercase hexadecimal characters")
	}
	if evidenceID == "" || evidenceURI == "" || endorsementScope == "" {
		return Request{}, errors.New("evidence ID, URI, and endorsement scope are required")
	}
	if len(evidence) == 0 {
		return Request{}, errors.New("evidence bytes are required")
	}
	copyEvidence := append([]byte(nil), evidence...)
	return Request{ReleaseSHA: releaseSHA, EvidenceID: evidenceID, EvidenceURI: evidenceURI, Evidence: copyEvidence, EndorsementScope: endorsementScope}, nil
}

func EvidenceDigest(evidence []byte) string {
	sum := sha256.Sum256(evidence)
	return hex.EncodeToString(sum[:])
}

func (c *Client) Attest(ctx context.Context, req Request) (Record, error) {
	if c == nil || c.gateway == nil {
		return Record{}, errors.New("Fabric client is not configured")
	}
	if !releasePattern.MatchString(req.ReleaseSHA) || req.EvidenceID == "" || len(req.Evidence) == 0 {
		return Record{}, errors.New("invalid Fabric attestation request")
	}
	digest := EvidenceDigest(req.Evidence)
	record, err := c.gateway.SubmitAttestation(ctx, req, digest)
	if err != nil {
		return Record{}, err
	}
	if record.ReleaseSHA != req.ReleaseSHA || record.EvidenceID != req.EvidenceID || record.EvidenceSHA256 != digest {
		return Record{}, errors.New("Fabric attestation response failed binding validation")
	}
	return record, nil
}

func (c *Client) VerifyRecord(ctx context.Context, recordID string) (Record, error) {
	if c == nil || c.gateway == nil {
		return Record{}, errors.New("Fabric client is not configured")
	}
	return c.gateway.EvaluateAttestation(ctx, strings.TrimSpace(recordID))
}

func (c *Client) Verify(ctx context.Context, recordID string, expectedDigest string) (bool, error) {
	if c == nil || c.gateway == nil {
		return false, errors.New("Fabric client is not configured")
	}
	expectedDigest = strings.TrimSpace(expectedDigest)
	if !digestPattern.MatchString(expectedDigest) {
		return false, fmt.Errorf("invalid expected evidence digest")
	}
	record, err := c.VerifyRecord(ctx, recordID)
	if err != nil {
		return false, err
	}
	return record.EvidenceSHA256 == expectedDigest, nil
}
