package provider

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
)

// YellowCardExecutionRuntime carries only the enabled sender and non-sensitive
// secret-version identifiers for operational evidence. It does not expose API
// keys or HMAC bytes outside the trusted runtime.
type YellowCardExecutionRuntime struct {
	Sender        YellowCardSender
	APIKeyVersion string
	HMACVersion   string
	Enabled       bool
}

func parseStrictBoolean(value string, fallback bool) (bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	if value == "true" {
		return true, nil
	}
	if value == "false" {
		return false, nil
	}
	return false, fmt.Errorf("boolean deployment flag must be true or false")
}

// YellowCardExecutionRuntimeFromEnvironment is an explicit activation boundary.
// A missing or false feature flag returns a disabled runtime; a true flag with
// incomplete or unsafe deployment configuration returns an error and prevents
// the payment engine from serving a misleading partially-enabled process.
func YellowCardExecutionRuntimeFromEnvironment(ctx context.Context, getenv func(string) string) (YellowCardExecutionRuntime, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	enabled, err := parseStrictBoolean(getenv("UMOJA_YELLOWCARD_EXECUTION_ENABLED"), false)
	if err != nil {
		return YellowCardExecutionRuntime{}, err
	}
	if !enabled {
		return YellowCardExecutionRuntime{Sender: DisabledYellowCardClient{}, Enabled: false}, nil
	}
	if getenv("UMOJA_YELLOWCARD_ENABLED") != "true" {
		return YellowCardExecutionRuntime{}, errors.New("Yellow Card execution requires UMOJA_YELLOWCARD_ENABLED=true")
	}
	environment := strings.TrimSpace(getenv("UMOJA_YELLOWCARD_ENVIRONMENT"))
	if environment != "sandbox" && environment != "production" {
		return YellowCardExecutionRuntime{}, errors.New("Yellow Card execution environment must be sandbox or production")
	}
	forceAccept, err := parseStrictBoolean(getenv("UMOJA_YELLOWCARD_ALLOW_FORCE_ACCEPT"), false)
	if err != nil {
		return YellowCardExecutionRuntime{}, err
	}
	if forceAccept {
		return YellowCardExecutionRuntime{}, errors.New("Yellow Card force-accept must remain disabled")
	}
	material, err := YellowCardSigningMaterialFromEnvironment(ctx, getenv)
	if err != nil {
		return YellowCardExecutionRuntime{}, err
	}
	allowLoopback, err := parseStrictBoolean(getenv("UMOJA_YELLOWCARD_ALLOW_INSECURE_LOOPBACK"), false)
	if err != nil {
		return YellowCardExecutionRuntime{}, err
	}
	client, err := NewYellowCardClient(YellowCardConfig{
		BaseURL:               getenv("UMOJA_YELLOWCARD_EXECUTION_BASE_URL"),
		Signer:                material.Signer,
		AllowInsecureLoopback: allowLoopback,
	})
	if err != nil {
		return YellowCardExecutionRuntime{}, fmt.Errorf("configure Yellow Card execution client: %w", err)
	}
	return YellowCardExecutionRuntime{Sender: client, APIKeyVersion: material.APIKeyVersion, HMACVersion: material.HMACVersion, Enabled: true}, nil
}
