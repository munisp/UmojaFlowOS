package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var releaseSHApattern = regexp.MustCompile(`^[a-f0-9]{40}$`)

type AttestationContract struct{ contractapi.Contract }

type Attestation struct {
	AttestationID    string `json:"attestation_id"`
	ReleaseSHA       string `json:"release_sha"`
	EvidenceID       string `json:"evidence_id"`
	EvidenceSHA256   string `json:"evidence_sha256"`
	EvidenceURI      string `json:"evidence_uri"`
	Subject          string `json:"subject"`
	EndorsementScope string `json:"endorsement_scope"`
	CreatedBy        string `json:"created_by"`
	CreatedAt        string `json:"created_at"`
	Status           string `json:"status"`
}

func deterministicID(releaseSHA, evidenceID, evidenceSHA256 string) string {
	sum := sha256.Sum256([]byte(releaseSHA + "\x00" + evidenceID + "\x00" + evidenceSHA256))
	return hex.EncodeToString(sum[:])
}

func (c *AttestationContract) CreateAttestation(ctx contractapi.TransactionContextInterface, releaseSHA, evidenceID, evidenceSHA256, evidenceURI, endorsementScope string) (*Attestation, error) {
	releaseSHA = strings.TrimSpace(releaseSHA)
	evidenceID = strings.TrimSpace(evidenceID)
	evidenceSHA256 = strings.TrimSpace(evidenceSHA256)
	evidenceURI = strings.TrimSpace(evidenceURI)
	endorsementScope = strings.TrimSpace(endorsementScope)
	if !releaseSHApattern.MatchString(releaseSHA) {
		return nil, errors.New("release_sha must be 40 lowercase hexadecimal characters")
	}
	if evidenceID == "" || evidenceURI == "" || endorsementScope == "" {
		return nil, errors.New("evidence_id, evidence_uri, and endorsement_scope are required")
	}
	if !sha256Pattern.MatchString(evidenceSHA256) {
		return nil, errors.New("evidence_sha256 must be 64 lowercase hexadecimal characters")
	}
	id := deterministicID(releaseSHA, evidenceID, evidenceSHA256)
	exists, err := c.AttestationExists(ctx, id)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("attestation %s already exists", id)
	}
	creator, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, fmt.Errorf("read creator identity: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	item := &Attestation{AttestationID: id, ReleaseSHA: releaseSHA, EvidenceID: evidenceID, EvidenceSHA256: evidenceSHA256, EvidenceURI: evidenceURI, Subject: creator, EndorsementScope: endorsementScope, CreatedBy: creator, CreatedAt: now, Status: "endorsed"}
	bytes, err := json.Marshal(item)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutState(id, bytes); err != nil {
		return nil, fmt.Errorf("store attestation: %w", err)
	}
	return item, nil
}

func (c *AttestationContract) GetAttestation(ctx contractapi.TransactionContextInterface, id string) (*Attestation, error) {
	bytes, err := ctx.GetStub().GetState(strings.TrimSpace(id))
	if err != nil {
		return nil, err
	}
	if len(bytes) == 0 {
		return nil, fmt.Errorf("attestation %s not found", id)
	}
	var item Attestation
	if err := json.Unmarshal(bytes, &item); err != nil {
		return nil, fmt.Errorf("decode attestation: %w", err)
	}
	return &item, nil
}

func (c *AttestationContract) AttestationExists(ctx contractapi.TransactionContextInterface, id string) (bool, error) {
	bytes, err := ctx.GetStub().GetState(strings.TrimSpace(id))
	if err != nil {
		return false, err
	}
	return len(bytes) > 0, nil
}

func (c *AttestationContract) VerifyDigest(ctx contractapi.TransactionContextInterface, id, evidenceSHA256 string) (bool, error) {
	if !sha256Pattern.MatchString(strings.TrimSpace(evidenceSHA256)) {
		return false, errors.New("evidence_sha256 must be 64 lowercase hexadecimal characters")
	}
	item, err := c.GetAttestation(ctx, id)
	if err != nil {
		return false, err
	}
	return item.EvidenceSHA256 == strings.TrimSpace(evidenceSHA256), nil
}

func main() {
	chaincode, err := contractapi.NewChaincode(&AttestationContract{})
	if err != nil {
		panic(err)
	}
	if err := chaincode.Start(); err != nil {
		panic(err)
	}
}
