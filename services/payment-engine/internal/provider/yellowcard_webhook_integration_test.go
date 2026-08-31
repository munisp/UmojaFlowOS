package provider

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testTLSCertificate(t *testing.T) (tlsCert tls.Certificate, roots *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: new(big.Int).SetInt64(1), Subject: pkix.Name{CommonName: "redis.test"}, DNSNames: []string{"redis.test"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	tlsCert, err = tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	roots = x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certPEM) {
		t.Fatal("failed to add test certificate")
	}
	return tlsCert, roots
}

func runTLSRESPServer(t *testing.T, response string, requireAuth bool, authOK bool) (address string, cert tls.Certificate) {
	t.Helper()
	generatedCert, _ := testTLSCertificate(t)
	cert = generatedCert
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				reader := bufio.NewReader(conn)
				if requireAuth {
					if err := readTestRESPCommand(reader); err != nil {
						return
					}
					if authOK {
						_, _ = conn.Write([]byte("+OK\r\n"))
					} else {
						_, _ = conn.Write([]byte("-NOAUTH\r\n"))
						return
					}
				}
				if err := readTestRESPCommand(reader); err != nil {
					return
				}
				_, _ = conn.Write([]byte(response))
			}()
		}
	}()
	return listener.Addr().String(), cert
}

func readTestRESPCommand(reader *bufio.Reader) error {
	prefix, err := reader.ReadByte()
	if err != nil || prefix != '*' {
		return fmt.Errorf("invalid RESP array prefix: %v", err)
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return err
	}
	count, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || count < 1 {
		return fmt.Errorf("invalid RESP array count: %v", err)
	}
	for i := 0; i < count; i++ {
		if prefix, err := reader.ReadByte(); err != nil || prefix != '$' {
			return fmt.Errorf("invalid RESP bulk prefix: %v", err)
		}
		lengthLine, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		length, err := strconv.Atoi(strings.TrimSpace(lengthLine))
		if err != nil || length < 0 || length > 4096 {
			return fmt.Errorf("invalid RESP bulk length: %v", err)
		}
		payload := make([]byte, length+2)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return err
		}
	}
	return nil
}

func TestRedisReplayStoreReservesOverTLSAndHandlesExistingKey(t *testing.T) {
	address, cert := runTLSRESPServer(t, "+OK\r\n", true, true)
	store := &RedisReplayStore{Address: address, Password: []byte("test-password"), KeyPrefix: "test:", TLSConfig: &tls.Config{RootCAs: certPool(t, cert), ServerName: "redis.test"}, Timeout: time.Second}
	reserved, err := store.Reserve(context.Background(), "event-1", 30*time.Second)
	if err != nil || !reserved {
		t.Fatalf("reserved=%v err=%v", reserved, err)
	}

	existingAddress, existingCert := runTLSRESPServer(t, "$-1\r\n", false, true)
	existing := &RedisReplayStore{Address: existingAddress, TLSConfig: &tls.Config{RootCAs: certPool(t, existingCert), ServerName: "redis.test"}, Timeout: time.Second}
	reserved, err = existing.Reserve(context.Background(), "event-1", time.Second)
	if err != nil || reserved {
		t.Fatalf("existing-key reserved=%v err=%v", reserved, err)
	}
}

func TestRedisReplayStoreFailsClosedOnAuthenticationAndProtocolErrors(t *testing.T) {
	address, cert := runTLSRESPServer(t, "+OK\r\n", true, false)
	store := &RedisReplayStore{Address: address, Password: []byte("wrong"), TLSConfig: &tls.Config{RootCAs: certPool(t, cert), ServerName: "redis.test"}, Timeout: time.Second}
	if _, err := store.Reserve(context.Background(), "event", time.Second); err == nil || !strings.Contains(err.Error(), "replay Redis returned an error") {
		t.Fatalf("auth error=%v", err)
	}

	badAddress, badCert := runTLSRESPServer(t, ":1\r\n", false, true)
	bad := &RedisReplayStore{Address: badAddress, TLSConfig: &tls.Config{RootCAs: certPool(t, badCert), ServerName: "redis.test"}, Timeout: time.Second}
	if _, err := bad.Reserve(context.Background(), "event", time.Second); err == nil || !strings.Contains(err.Error(), "unexpected replay Redis response") {
		t.Fatalf("protocol error=%v", err)
	}
	if _, err := (&RedisReplayStore{}).Reserve(context.Background(), "", time.Second); !errors.Is(err, ErrWebhookDependency) {
		t.Fatalf("invalid dependency error=%v", err)
	}
}

func certPool(t *testing.T, cert tls.Certificate) *x509.CertPool {
	t.Helper()
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return pool
}

func TestFileEvidenceAndQueueAreIdempotentAndConflictSafe(t *testing.T) {
	evidence := WebhookEvidence{Provider: "yellow_card", EventID: "event-1", SequenceID: "seq-1", Status: "completed", PayloadSHA256: strings.Repeat("a", 64), ReceivedAt: time.Now().UTC(), SettlementAllowed: false}
	dir := t.TempDir()
	store := FileEvidenceStore{Directory: dir}
	created, err := store.Record(context.Background(), evidence)
	if err != nil || !created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	created, err = store.Record(context.Background(), evidence)
	if err != nil || created {
		t.Fatalf("duplicate created=%v err=%v", created, err)
	}
	conflict := evidence
	conflict.PayloadSHA256 = strings.Repeat("b", 64)
	if _, err := store.Record(context.Background(), conflict); !errors.Is(err, ErrWebhookEvidenceConflict) {
		t.Fatalf("conflict error=%v", err)
	}
	queue := FileReconciliationQueue{Directory: t.TempDir()}
	if created, err := queue.Enqueue(context.Background(), evidence); err != nil || !created {
		t.Fatalf("queue created=%v err=%v", created, err)
	}
	if _, err := (FileEvidenceStore{}).Record(context.Background(), evidence); !errors.Is(err, ErrWebhookDependency) {
		t.Fatalf("blank directory error=%v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("evidence entries=%d err=%v", len(entries), err)
	}
}
