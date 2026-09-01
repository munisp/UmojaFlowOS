package settlement

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"strconv"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func BenchmarkSettlementPooledConcurrent(b *testing.B) {
	latency := 2 * time.Millisecond
	if raw := os.Getenv("UMOJA_MESH_LATENCY_MS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
			latency = time.Duration(n) * time.Millisecond
		}
	}
	serverTLS, clientTLS := benchmarkTLSConfig(b)
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	srv := grpc.NewServer(grpc.Creds(credentials.NewTLS(serverTLS)))
	RegisterGRPCSettlementServer(srv, &GRPCSettlementServer{Handler: func(ctx context.Context, in Intent) (ProviderResult, error) {
		time.Sleep(latency)
		return ProviderResult{State: Settled, Reference: "pooled-bench"}, nil
	}})
	go srv.Serve(lis)
	defer srv.Stop()
	conn, err := grpc.Dial(lis.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(clientTLS)))
	if err != nil {
		b.Fatal(err)
	}
	defer conn.Close()
	client := NewGRPCSettlementClient(conn)
	in := validIntent()
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := client.Execute(context.Background(), in); err != nil {
				b.Error(err)
			}
		}
	})
}

func TestGRPCSettlementMutualTLSHandshakeAndAuthorization(t *testing.T) {
	caCert, caKey := testCA(t)
	serverPair, _, _ := testCertificate(t, "payment-engine", caCert, false, caKey)
	clientPair, _, _ := testCertificate(t, "control-plane", caCert, false, caKey)
	caPool := x509.NewCertPool()
	caPool.AddCert(caCert)
	serverTLS := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverPair}, ClientCAs: caPool, ClientAuth: tls.RequireAndVerifyClientCert}
	clientTLS := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: caPool, Certificates: []tls.Certificate{clientPair}, ServerName: "payment-engine"}
	auth := func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		md, _ := metadata.FromIncomingContext(ctx)
		principal := ""
		if values := md.Get("x-umoja-principal"); len(values) > 0 {
			principal = values[0]
		}
		if principal != "control-plane" && principal != "reconciliation-worker" {
			return nil, status.Error(codes.PermissionDenied, "caller principal is not allowlisted")
		}
		return handler(ctx, req)
	}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer(grpc.Creds(credentials.NewTLS(serverTLS)), grpc.UnaryInterceptor(auth))
	RegisterGRPCSettlementServer(srv, &GRPCSettlementServer{Handler: func(context.Context, Intent) (ProviderResult, error) {
		return ProviderResult{State: Settled, Reference: "mtls-ok"}, nil
	}})
	go srv.Serve(lis)
	defer srv.Stop()
	conn, err := grpc.Dial(lis.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(clientTLS)))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client := NewGRPCSettlementClient(conn)
	ctx := metadata.AppendToOutgoingContext(context.Background(), "x-umoja-principal", "control-plane")
	result, err := client.Execute(ctx, validIntent())
	if err != nil {
		t.Fatalf("allowlisted mTLS call failed: %v", err)
	}
	if result.Reference != "mtls-ok" {
		t.Fatalf("unexpected reference %q", result.Reference)
	}
	denied := metadata.AppendToOutgoingContext(context.Background(), "x-umoja-principal", "unknown-service")
	if _, err := client.Execute(denied, validIntent()); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("expected PermissionDenied, got %v", err)
	}
}

func TestGRPCSettlementRejectsMissingClientCertificate(t *testing.T) {
	caCert, caKey := testCA(t)
	serverPair, _, _ := testCertificate(t, "payment-engine", caCert, false, caKey)
	caPool := x509.NewCertPool()
	caPool.AddCert(caCert)
	serverTLS := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverPair}, ClientCAs: caPool, ClientAuth: tls.RequireAndVerifyClientCert}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer(grpc.Creds(credentials.NewTLS(serverTLS)))
	RegisterGRPCSettlementServer(srv, &GRPCSettlementServer{Handler: func(context.Context, Intent) (ProviderResult, error) { return ProviderResult{State: Settled}, nil }})
	go srv.Serve(lis)
	defer srv.Stop()
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	conn, err := grpc.Dial(lis.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: "payment-engine"})))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, err = NewGRPCSettlementClient(conn).Execute(context.Background(), validIntent())
	if err == nil {
		t.Fatal("expected missing client certificate to fail")
	}
}

func testCA(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey) {
	_, cert, key := testCertificate(t, "umoja-test-ca", nil, true, nil)
	return cert, key
}

func testCertificate(t testing.TB, name string, ca *x509.Certificate, isCA bool, signer *ecdsa.PrivateKey) (tls.Certificate, *x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: name}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment}
	if isCA {
		tmpl.IsCA = true
		tmpl.BasicConstraintsValid = true
		tmpl.KeyUsage |= x509.KeyUsageCertSign
		ca = tmpl
		signer = key
	} else {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}
		tmpl.DNSNames = []string{name}
	}
	parent := ca
	if parent == nil {
		parent = tmpl
	}
	issuer := signer
	if issuer == nil {
		issuer = key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, issuer)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM, _ := x509.MarshalPKCS8PrivateKey(key)
	pair, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyPEM}))
	if err != nil {
		t.Fatal(err)
	}
	return pair, cert, key
}
