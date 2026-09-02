package settlement

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

func benchmarkTLSConfig(b *testing.B) (*tls.Config, *tls.Config) {
	b.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		b.Fatal(err)
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	certDER, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}, &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "localhost"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageCertSign, IsCA: true}, &key.PublicKey, key)
	if err != nil {
		b.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		b.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}, &tls.Config{RootCAs: pool, ServerName: "localhost", MinVersion: tls.VersionTLS13}
}

func BenchmarkSettlementTransportTLSLatency(b *testing.B) {
	in := validIntent()
	serverTLS, clientTLS := benchmarkTLSConfig(b)
	b.Run("grpc_tls_2ms", func(b *testing.B) {
		lis, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			b.Fatal(err)
		}
		srv := grpc.NewServer(grpc.Creds(credentials.NewTLS(serverTLS)))
		RegisterGRPCSettlementServer(srv, &GRPCSettlementServer{Handler: func(ctx context.Context, in Intent) (ProviderResult, error) {
			time.Sleep(2 * time.Millisecond)
			return ProviderResult{State: Settled, Reference: "tls-bench"}, nil
		}})
		go srv.Serve(lis)
		defer srv.Stop()
		conn, err := grpc.Dial(lis.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(clientTLS)))
		if err != nil {
			b.Fatal(err)
		}
		defer conn.Close()
		client := NewGRPCSettlementClient(conn)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := client.Execute(context.Background(), in); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("http_tls_2ms", func(b *testing.B) {
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(2 * time.Millisecond)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"reference":"tls-bench","state":"settled"}`))
		}))
		srv.TLS = serverTLS
		srv.StartTLS()
		defer srv.Close()
		provider, err := NewHTTPFiatRail(HTTPProviderConfig{BaseURL: srv.URL, Client: srv.Client()})
		if err != nil {
			b.Fatal(err)
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := provider.Collect(context.Background(), in); err != nil {
				b.Fatal(err)
			}
		}
	})
}
