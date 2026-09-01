//go:build fabric_integration

package attestation

import (
	"context"
	"os"
	"testing"
	"time"
)

func liveGatewayConfig(t *testing.T, prefix string) GatewayConfig {
	t.Helper()
	get := func(name string) string { return os.Getenv(prefix + name) }
	return GatewayConfig{
		Endpoint:               get("ENDPOINT"),
		TLSRootCertificatePath: get("TLS_ROOT_CERT_PATH"),
		CertificatePath:        get("IDENTITY_CERT_PATH"),
		PrivateKeyPath:         get("IDENTITY_KEY_PATH"),
		MSPID:                  get("MSP_ID"),
		Channel:                get("CHANNEL"),
		Chaincode:              get("CHAINCODE"),
		CommitStatusTimeout:    30 * time.Second,
	}
}

func requireLiveConfig(t *testing.T, cfg GatewayConfig) {
	t.Helper()
	for name, value := range map[string]string{
		"endpoint": cfg.Endpoint, "TLS root": cfg.TLSRootCertificatePath, "identity certificate": cfg.CertificatePath,
		"identity key": cfg.PrivateKeyPath, "MSP ID": cfg.MSPID, "channel": cfg.Channel, "chaincode": cfg.Chaincode,
	} {
		if value == "" {
			t.Fatalf("missing live Fabric %s configuration", name)
		}
	}
}

func TestFabricLiveDuplicateAttestationIsRejected(t *testing.T) {
	if os.Getenv("FABRIC_LIVE") != "1" {
		t.Skip("set FABRIC_LIVE=1 to run against an approved Fabric network")
	}
	cfg := liveGatewayConfig(t, "UMOJA_FABRIC_")
	requireLiveConfig(t, cfg)
	gateway, err := NewGatewayClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	client, err := NewClient(gateway)
	if err != nil {
		t.Fatal(err)
	}
	req, err := NewRequest(os.Getenv("FABRIC_TEST_RELEASE_SHA"), os.Getenv("FABRIC_TEST_EVIDENCE_ID"), os.Getenv("FABRIC_TEST_EVIDENCE_URI"), os.Getenv("FABRIC_TEST_ENDORSEMENT_SCOPE"), []byte(os.Getenv("FABRIC_TEST_EVIDENCE")))
	if err != nil {
		t.Fatal(err)
	}
	first, err := client.Attest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if first.AttestationID == "" {
		t.Fatal("live attestation returned no ID")
	}
	if _, err := client.Attest(context.Background(), req); err == nil {
		t.Fatal("duplicate attestation unexpectedly succeeded")
	}
	ok, err := client.Verify(context.Background(), first.AttestationID, EvidenceDigest(req.Evidence))
	if err != nil || !ok {
		t.Fatalf("read-only verification failed: ok=%v err=%v", ok, err)
	}
}

func TestFabricLivePartitionFailsClosed(t *testing.T) {
	if os.Getenv("FABRIC_LIVE_PARTITION") != "1" {
		t.Skip("set FABRIC_LIVE_PARTITION=1 with an externally blackholed endpoint to run")
	}
	cfg := liveGatewayConfig(t, "UMOJA_FABRIC_PARTITION_")
	requireLiveConfig(t, cfg)
	gateway, err := NewGatewayClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer gateway.Close()
	client, err := NewClient(gateway)
	if err != nil {
		t.Fatal(err)
	}
	req, err := NewRequest(os.Getenv("FABRIC_TEST_RELEASE_SHA"), os.Getenv("FABRIC_TEST_EVIDENCE_ID"), os.Getenv("FABRIC_TEST_EVIDENCE_URI"), os.Getenv("FABRIC_TEST_ENDORSEMENT_SCOPE"), []byte(os.Getenv("FABRIC_TEST_EVIDENCE")))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := client.Attest(ctx, req); err == nil {
		t.Fatal("partitioned Fabric submit unexpectedly succeeded")
	}
}
