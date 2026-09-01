package attestation

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type RuntimeConfig struct {
	GatewayConfig
	Enabled         bool
	AttestationOnly bool
}

func LoadRuntimeConfig(getenv func(string) string, stat func(string) error) (RuntimeConfig, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if stat == nil {
		stat = func(path string) error { _, err := os.Stat(path); return err }
	}
	if strings.EqualFold(strings.TrimSpace(getenv("UMOJA_FABRIC_ATTESTATION_ENABLED")), "false") {
		return RuntimeConfig{Enabled: false}, nil
	}
	cfg := RuntimeConfig{Enabled: true, AttestationOnly: true, GatewayConfig: GatewayConfig{
		Endpoint:               getenv("UMOJA_FABRIC_GATEWAY_ENDPOINT"),
		TLSRootCertificatePath: getenv("UMOJA_FABRIC_TLS_ROOT_CERT_PATH"),
		CertificatePath:        getenv("UMOJA_FABRIC_IDENTITY_CERT_PATH"),
		PrivateKeyPath:         getenv("UMOJA_FABRIC_IDENTITY_KEY_PATH"),
		MSPID:                  getenv("UMOJA_FABRIC_MSP_ID"),
		Channel:                getenv("UMOJA_FABRIC_CHANNEL"),
		Chaincode:              getenv("UMOJA_FABRIC_CHAINCODE"),
	}}
	if strings.EqualFold(strings.TrimSpace(getenv("UMOJA_FABRIC_ATTESTATION_ONLY")), "false") {
		return RuntimeConfig{}, errors.New("Fabric must remain attestation-only; settlement authority is prohibited")
	}
	if cfg.Endpoint == "" || cfg.TLSRootCertificatePath == "" || cfg.CertificatePath == "" || cfg.PrivateKeyPath == "" || cfg.MSPID == "" || cfg.Channel == "" || cfg.Chaincode == "" {
		return RuntimeConfig{}, errors.New("all Fabric Gateway configuration fields are required")
	}
	cfg.CommitStatusTimeout = 30 * time.Second
	if raw := strings.TrimSpace(getenv("UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT")); raw != "" {
		timeout, err := time.ParseDuration(raw)
		if err != nil || timeout <= 0 || timeout > 5*time.Minute {
			return RuntimeConfig{}, fmt.Errorf("UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT must be a duration between 1ns and 5m: %q", raw)
		}
		cfg.CommitStatusTimeout = timeout
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Scheme != "grpcs" {
		return RuntimeConfig{}, fmt.Errorf("Fabric Gateway endpoint must use grpcs: %s", cfg.Endpoint)
	}
	for name, path := range map[string]string{"TLS root": cfg.TLSRootCertificatePath, "identity certificate": cfg.CertificatePath, "identity key": cfg.PrivateKeyPath} {
		if err := stat(path); err != nil {
			return RuntimeConfig{}, fmt.Errorf("%s file unavailable: %w", name, err)
		}
	}
	return cfg, nil
}
