package attestation

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	fabric "github.com/hyperledger/fabric-gateway/pkg/client"
	"github.com/hyperledger/fabric-gateway/pkg/identity"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type GatewayConfig struct {
	Endpoint               string
	TLSRootCertificatePath string
	CertificatePath        string
	PrivateKeyPath         string
	MSPID                  string
	Channel                string
	Chaincode              string
	CommitStatusTimeout    time.Duration
}

type GatewayClient struct {
	gateway  *fabric.Gateway
	contract *fabric.Contract
	conn     *grpc.ClientConn
}

func NewGatewayClient(cfg GatewayConfig) (*GatewayClient, error) {
	cfg.Endpoint = strings.TrimSpace(cfg.Endpoint)
	cfg.MSPID = strings.TrimSpace(cfg.MSPID)
	cfg.Channel = strings.TrimSpace(cfg.Channel)
	cfg.Chaincode = strings.TrimSpace(cfg.Chaincode)
	if cfg.Endpoint == "" || cfg.MSPID == "" || cfg.Channel == "" || cfg.Chaincode == "" {
		return nil, errors.New("Fabric endpoint, MSP ID, channel, and chaincode are required")
	}
	rootPEM, err := os.ReadFile(cfg.TLSRootCertificatePath)
	if err != nil {
		return nil, fmt.Errorf("read Fabric TLS root: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(rootPEM) {
		return nil, errors.New("parse Fabric TLS root certificate")
	}
	certificatePEM, err := os.ReadFile(cfg.CertificatePath)
	if err != nil {
		return nil, fmt.Errorf("read Fabric identity: %w", err)
	}
	certificate, err := identity.CertificateFromPEM(certificatePEM)
	if err != nil {
		return nil, fmt.Errorf("parse Fabric identity: %w", err)
	}
	fabricIdentity, err := identity.NewX509Identity(cfg.MSPID, certificate)
	if err != nil {
		return nil, fmt.Errorf("create Fabric identity: %w", err)
	}
	privateKeyPEM, err := os.ReadFile(cfg.PrivateKeyPath)
	if err != nil {
		return nil, fmt.Errorf("read Fabric private key: %w", err)
	}
	privateKey, err := identity.PrivateKeyFromPEM(privateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse Fabric private key: %w", err)
	}
	sign, err := identity.NewPrivateKeySign(privateKey)
	if err != nil {
		return nil, fmt.Errorf("create Fabric signer: %w", err)
	}
	conn, err := grpc.NewClient(cfg.Endpoint, grpc.WithTransportCredentials(credentials.NewClientTLSFromCert(pool, "")))
	if err != nil {
		return nil, fmt.Errorf("connect to Fabric Gateway: %w", err)
	}
	connectOptions := []fabric.ConnectOption{fabric.WithSign(sign), fabric.WithClientConnection(conn)}
	if cfg.CommitStatusTimeout > 0 {
		connectOptions = append(connectOptions, fabric.WithCommitStatusTimeout(cfg.CommitStatusTimeout))
	}
	gw, err := fabric.Connect(fabricIdentity, connectOptions...)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("initialize Fabric Gateway: %w", err)
	}
	return &GatewayClient{gateway: gw, contract: gw.GetNetwork(cfg.Channel).GetContract(cfg.Chaincode), conn: conn}, nil
}

func (g *GatewayClient) Close() error {
	if g == nil {
		return nil
	}
	if g.gateway != nil {
		_ = g.gateway.Close()
	}
	if g.conn != nil {
		return g.conn.Close()
	}
	return nil
}

func (g *GatewayClient) SubmitAttestation(ctx context.Context, req Request, digest string) (Record, error) {
	if g == nil || g.contract == nil {
		return Record{}, errors.New("Fabric Gateway contract is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	result, err := g.contract.SubmitWithContext(ctx, "CreateAttestation", fabric.WithArguments(req.ReleaseSHA, req.EvidenceID, digest, req.EvidenceURI, req.EndorsementScope))
	if err != nil {
		return Record{}, fmt.Errorf("submit Fabric attestation: %w", err)
	}
	var record Record
	if err := json.Unmarshal(result, &record); err != nil {
		return Record{}, fmt.Errorf("decode Fabric attestation: %w", err)
	}
	if record.ReleaseSHA != req.ReleaseSHA || record.EvidenceID != req.EvidenceID || record.EvidenceSHA256 != digest {
		return Record{}, errors.New("Fabric attestation response failed binding validation")
	}
	return record, nil
}

func (g *GatewayClient) EvaluateAttestation(ctx context.Context, recordID string) (Record, error) {
	if g == nil || g.contract == nil {
		return Record{}, errors.New("Fabric Gateway contract is not configured")
	}
	result, err := g.contract.EvaluateWithContext(ctx, "GetAttestation", fabric.WithArguments(recordID))
	if err != nil {
		return Record{}, fmt.Errorf("evaluate Fabric attestation: %w", err)
	}
	var record Record
	if err := json.Unmarshal(result, &record); err != nil {
		return Record{}, fmt.Errorf("decode Fabric attestation: %w", err)
	}
	return record, nil
}
