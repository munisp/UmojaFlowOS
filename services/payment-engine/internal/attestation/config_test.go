package attestation

import (
	"testing"
	"time"
)

func TestLoadRuntimeConfigRequiresAttestationOnly(t *testing.T) {
	files := map[string]bool{"/tls": true, "/cert": true, "/key": true}
	values := map[string]string{"UMOJA_FABRIC_GATEWAY_ENDPOINT": "grpcs://gateway.example:7051", "UMOJA_FABRIC_TLS_ROOT_CERT_PATH": "/tls", "UMOJA_FABRIC_IDENTITY_CERT_PATH": "/cert", "UMOJA_FABRIC_IDENTITY_KEY_PATH": "/key", "UMOJA_FABRIC_MSP_ID": "Org1MSP", "UMOJA_FABRIC_CHANNEL": "umoja-channel", "UMOJA_FABRIC_CHAINCODE": "consortium-attestation", "UMOJA_FABRIC_ATTESTATION_ONLY": "true"}
	cfg, err := LoadRuntimeConfig(func(k string) string { return values[k] }, func(p string) error {
		if files[p] {
			return nil
		}
		return errMissingFile{}
	})
	if err != nil || !cfg.Enabled || !cfg.AttestationOnly {
		t.Fatalf("expected valid attestation-only config: %#v err=%v", cfg, err)
	}
}

func TestLoadRuntimeConfigCommitStatusTimeout(t *testing.T) {
	base := map[string]string{"UMOJA_FABRIC_GATEWAY_ENDPOINT": "grpcs://gateway.example:7051", "UMOJA_FABRIC_TLS_ROOT_CERT_PATH": "/tls", "UMOJA_FABRIC_IDENTITY_CERT_PATH": "/cert", "UMOJA_FABRIC_IDENTITY_KEY_PATH": "/key", "UMOJA_FABRIC_MSP_ID": "Org1MSP", "UMOJA_FABRIC_CHANNEL": "umoja-channel", "UMOJA_FABRIC_CHAINCODE": "consortium-attestation", "UMOJA_FABRIC_ATTESTATION_ONLY": "true"}
	get := func(values map[string]string) (RuntimeConfig, error) {
		return LoadRuntimeConfig(func(k string) string { return values[k] }, func(string) error { return nil })
	}
	cfg, err := get(base)
	if err != nil || cfg.CommitStatusTimeout != 30*time.Second {
		t.Fatalf("default timeout=%v err=%v", cfg.CommitStatusTimeout, err)
	}
	base["UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT"] = "45s"
	cfg, err = get(base)
	if err != nil || cfg.CommitStatusTimeout != 45*time.Second {
		t.Fatalf("custom timeout=%v err=%v", cfg.CommitStatusTimeout, err)
	}
	for _, invalid := range []string{"0s", "6m", "not-a-duration"} {
		base["UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT"] = invalid
		if _, err := get(base); err == nil {
			t.Fatalf("accepted invalid timeout %q", invalid)
		}
	}
}

func TestLoadRuntimeConfigRejectsUnsafeValues(t *testing.T) {
	base := map[string]string{"UMOJA_FABRIC_GATEWAY_ENDPOINT": "grpcs://gateway.example:7051", "UMOJA_FABRIC_TLS_ROOT_CERT_PATH": "/tls", "UMOJA_FABRIC_IDENTITY_CERT_PATH": "/cert", "UMOJA_FABRIC_IDENTITY_KEY_PATH": "/key", "UMOJA_FABRIC_MSP_ID": "Org1MSP", "UMOJA_FABRIC_CHANNEL": "umoja-channel", "UMOJA_FABRIC_CHAINCODE": "consortium-attestation", "UMOJA_FABRIC_ATTESTATION_ONLY": "true"}
	for key, value := range map[string]string{"UMOJA_FABRIC_GATEWAY_ENDPOINT": "https://gateway.example:7051", "UMOJA_FABRIC_ATTESTATION_ONLY": "false"} {
		values := map[string]string{}
		for k, v := range base {
			values[k] = v
		}
		values[key] = value
		if _, err := LoadRuntimeConfig(func(k string) string { return values[k] }, func(string) error { return nil }); err == nil {
			t.Fatalf("accepted unsafe %s", key)
		}
	}
}

type errMissingFile struct{}

func (errMissingFile) Error() string { return "missing" }
