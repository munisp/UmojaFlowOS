package settlement

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	settlementv1 "github.com/munisp/UmojaFlowOS/services/payment-engine/internal/settlement/gen/umoja/settlement/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

const grpcMethodExecute = settlementv1.Settlement_Execute_FullMethodName
const grpcMethodQuery = settlementv1.Settlement_Query_FullMethodName

type GRPCSettlementHandler func(context.Context, Intent) (ProviderResult, error)
type GRPCSettlementQueryHandler func(context.Context, Intent) (ProviderResult, error)

type GRPCSettlementServer struct {
	settlementv1.UnimplementedSettlementServer
	Handler      GRPCSettlementHandler
	QueryHandler GRPCSettlementQueryHandler
}

func (s *GRPCSettlementServer) Execute(ctx context.Context, req *settlementv1.SettlementRequest) (*settlementv1.SettlementResponse, error) {
	if s == nil || s.Handler == nil {
		return nil, errors.New("settlement gRPC handler is not configured")
	}
	in, err := intentFromProto(req)
	if err != nil {
		return nil, err
	}
	out, err := s.Handler(ctx, in)
	if err != nil {
		return nil, err
	}
	return resultToProto(out, req.GetPayloadSha256()), nil
}

func (s *GRPCSettlementServer) Query(ctx context.Context, req *settlementv1.SettlementQueryRequest) (*settlementv1.SettlementResponse, error) {
	if s == nil || s.QueryHandler == nil {
		return nil, errors.New("settlement gRPC query handler is not configured")
	}
	in := Intent{ID: req.GetIntentId(), IdempotencyKey: req.GetIdempotencyKey(), TenantID: req.GetTenantId(), Asset: req.GetAsset(), Fiat: req.GetFiat()}
	if req == nil || in.ID == "" || in.IdempotencyKey == "" || in.TenantID == "" || req.GetPayloadSha256() == "" {
		return nil, ErrInvalidIntent
	}
	out, err := s.QueryHandler(ctx, in)
	if err != nil {
		return nil, err
	}
	return resultToProto(out, req.GetPayloadSha256()), nil
}

func RegisterGRPCSettlementServer(reg grpc.ServiceRegistrar, srv *GRPCSettlementServer) {
	if srv == nil {
		srv = &GRPCSettlementServer{}
	}
	settlementv1.RegisterSettlementServer(reg, srv)
}

type GRPCSettlementClient struct {
	client settlementv1.SettlementClient
}

func NewGRPCSettlementClient(conn grpc.ClientConnInterface) *GRPCSettlementClient {
	if conn == nil {
		return &GRPCSettlementClient{}
	}
	return &GRPCSettlementClient{client: settlementv1.NewSettlementClient(conn)}
}

func (c *GRPCSettlementClient) Execute(ctx context.Context, in Intent) (ProviderResult, error) {
	if c == nil || c.client == nil {
		return ProviderResult{State: Unknown, Reason: "gRPC client unavailable"}, ErrUnknown
	}
	req, err := intentToProto(in)
	if err != nil {
		return ProviderResult{State: Held, Reason: "invalid gRPC settlement intent"}, err
	}
	out, err := c.client.Execute(ctx, req)
	if err != nil {
		return ProviderResult{State: Unknown, Reason: "gRPC settlement outcome unknown"}, err
	}
	return resultFromProto(out, req.GetPayloadSha256())
}

func (c *GRPCSettlementClient) Query(ctx context.Context, in Intent) (ProviderResult, error) {
	if c == nil || c.client == nil {
		return ProviderResult{State: Unknown, Reason: "gRPC client unavailable"}, ErrUnknown
	}
	if err := validateIntent(in); err != nil {
		return ProviderResult{State: Held, Reason: "invalid gRPC settlement query"}, err
	}
	payloadDigest := digestPayload(in.Payload)
	out, err := c.client.Query(ctx, &settlementv1.SettlementQueryRequest{IntentId: in.ID, IdempotencyKey: in.IdempotencyKey, TenantId: in.TenantID, Asset: in.Asset, Fiat: in.Fiat, PayloadSha256: payloadDigest})
	if err != nil {
		return ProviderResult{State: Unknown, Reason: "gRPC settlement query outcome unknown"}, err
	}
	return resultFromProto(out, payloadDigest)
}

func intentToProto(in Intent) (*settlementv1.SettlementRequest, error) {
	if err := validateIntent(in); err != nil {
		return nil, err
	}
	return &settlementv1.SettlementRequest{IntentId: in.ID, IdempotencyKey: in.IdempotencyKey, TenantId: in.TenantID, Direction: string(in.Direction), Asset: in.Asset, Fiat: in.Fiat, AmountMinor: in.AmountMinor, Destination: in.Destination, CanonicalPayload: append([]byte(nil), in.Payload...), PayloadSha256: digestPayload(in.Payload), ExpiresAtRfc3339: in.ExpiresAt.UTC().Format(time.RFC3339Nano)}, nil
}

func intentFromProto(req *settlementv1.SettlementRequest) (Intent, error) {
	if req == nil || req.GetPayloadSha256() == "" || !strings.EqualFold(req.GetPayloadSha256(), digestPayload(req.GetCanonicalPayload())) {
		return Intent{}, ErrInvalidIntent
	}
	expiry, err := time.Parse(time.RFC3339Nano, req.GetExpiresAtRfc3339())
	if err != nil {
		return Intent{}, ErrInvalidIntent
	}
	in := Intent{ID: req.GetIntentId(), IdempotencyKey: req.GetIdempotencyKey(), TenantID: req.GetTenantId(), Direction: Direction(req.GetDirection()), Asset: req.GetAsset(), Fiat: req.GetFiat(), AmountMinor: req.GetAmountMinor(), Destination: req.GetDestination(), Payload: append([]byte(nil), req.GetCanonicalPayload()...), ExpiresAt: expiry}
	if err := validateIntent(in); err != nil {
		return Intent{}, err
	}
	return in, nil
}

func resultToProto(out ProviderResult, payloadDigest string) *settlementv1.SettlementResponse {
	return &settlementv1.SettlementResponse{State: string(out.State), Reference: out.Reference, BlockchainTx: out.BlockchainTx, Reason: out.Reason, RetryableWithoutEffect: out.RetryableWithoutEffect, PayloadSha256: payloadDigest, AttestationId: ""}
}

func resultFromProto(out *settlementv1.SettlementResponse, expectedDigest string) (ProviderResult, error) {
	if out == nil || out.GetState() == "" || out.GetPayloadSha256() == "" || !strings.EqualFold(out.GetPayloadSha256(), expectedDigest) {
		return ProviderResult{State: Unknown, Reason: "gRPC response binding invalid"}, ErrUnknown
	}
	return ProviderResult{Reference: out.GetReference(), State: State(out.GetState()), BlockchainTx: out.GetBlockchainTx(), Reason: out.GetReason(), RetryableWithoutEffect: out.GetRetryableWithoutEffect()}, nil
}

func digestPayload(payload []byte) string {
	// The canonical payload is already produced by the settlement coordinator.
	// Hashing here binds the typed transport to that canonical byte sequence.
	h := sha256.Sum256(payload)
	return hex.EncodeToString(h[:])
}

func LoadGRPCClientTLSConfig(caFile, certFile, keyFile, serverName string) (*tls.Config, error) {
	if caFile == "" || certFile == "" || keyFile == "" || serverName == "" {
		return nil, errors.New("gRPC mTLS requires CA, client certificate, client key, and server name")
	}
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read gRPC CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("gRPC CA contains no valid certificates")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load gRPC client certificate: %w", err)
	}
	return &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, Certificates: []tls.Certificate{cert}, ServerName: serverName, Renegotiation: tls.RenegotiateNever}, nil
}

func LoadGRPCServerTLSConfig(caFile, certFile, keyFile string) (*tls.Config, error) {
	if caFile == "" || certFile == "" || keyFile == "" {
		return nil, errors.New("gRPC mTLS server requires client CA, server certificate, and server key")
	}
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read gRPC client CA: %w", err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("gRPC client CA contains no valid certificates")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load gRPC server certificate: %w", err)
	}
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ClientCAs: clientCAs, ClientAuth: tls.RequireAndVerifyClientCert, Renegotiation: tls.RenegotiateNever}, nil
}

func DialGRPCSettlement(ctx context.Context, target string, tlsConfig *tls.Config, opts ...grpc.DialOption) (*grpc.ClientConn, error) {
	if target == "" {
		return nil, errors.New("gRPC settlement target is required")
	}
	if tlsConfig == nil {
		return nil, errors.New("TLS configuration is required for settlement gRPC")
	}
	opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)))
	return grpc.DialContext(ctx, target, opts...)
}
