package provider

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	NigerianRailEnabledEnv          = "NIGERIAN_RAIL_ENABLED"
	NigerianRailExecutionEnabledEnv = "NIGERIAN_RAIL_EXECUTION_ENABLED"
	NigerianRailBaseURLEnv          = "NIGERIAN_RAIL_BASE_URL"
	NigerianRailBearerTokenEnv      = "NIGERIAN_RAIL_BEARER_TOKEN"
	NigerianRailBearerTokenFileEnv  = "NIGERIAN_RAIL_BEARER_TOKEN_FILE"
	NigerianRailTimeoutEnv          = "NIGERIAN_RAIL_TIMEOUT"
	NigerianRailCABundleEnv         = "NIGERIAN_RAIL_CA_BUNDLE"
	NigerianRailMaxBodyBytesEnv     = "NIGERIAN_RAIL_MAX_BODY_BYTES"
)

const (
	defaultNigerianRailTimeout = 10 * time.Second
	maxNigerianRailTimeout     = 10 * time.Second
	defaultNigerianRailMaxBody = 256 * 1024
	maxNigerianRailMaxBody     = 4 * 1024 * 1024
)

// NigerianBankRailRuntimeConfig is the validated process configuration. The
// loader deliberately separates enablement from execution so an operator can
// deploy a disabled rail without credentials, while an enabled execution path
// cannot start with incomplete or unsafe configuration.
type NigerianBankRailRuntimeConfig struct {
	Enabled          bool
	ExecutionEnabled bool
	BaseURL          string
	BearerToken      string
	BearerTokenFile  string
	Timeout          time.Duration
	CABundle         string
	MaxBodyBytes     int64
	Production       bool
}

func parseStrictBool(getenv func(string) string, name string, defaultValue bool) (bool, error) {
	value := strings.TrimSpace(getenv(name))
	if value == "" {
		return defaultValue, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be exactly true or false", name)
	}
	return parsed, nil
}

func readBearerToken(getenv func(string) string) (token, file string, err error) {
	token = strings.TrimSpace(getenv(NigerianRailBearerTokenEnv))
	file = strings.TrimSpace(getenv(NigerianRailBearerTokenFileEnv))
	if token != "" && file != "" {
		return "", "", errors.New("NIGERIAN_RAIL_BEARER_TOKEN and NIGERIAN_RAIL_BEARER_TOKEN_FILE must not both be set")
	}
	if file == "" {
		return token, "", nil
	}
	contents, readErr := os.ReadFile(file)
	if readErr != nil {
		return "", file, fmt.Errorf("NIGERIAN_RAIL_BEARER_TOKEN_FILE is unreadable: %w", readErr)
	}
	// Secret mounts commonly terminate the file with one newline. Remove only
	// surrounding whitespace; the token itself is never logged or returned in
	// validation errors.
	token = strings.TrimSpace(string(contents))
	if token == "" {
		return "", file, errors.New("NIGERIAN_RAIL_BEARER_TOKEN_FILE is empty")
	}
	return token, file, nil
}

// LoadNigerianRailConfig reads and validates process environment. production
// controls whether loopback HTTP is forbidden; tests can pass false explicitly.
func LoadNigerianRailConfig(getenv func(string) string, production bool) (NigerianBankRailRuntimeConfig, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	enabled, err := parseStrictBool(getenv, NigerianRailEnabledEnv, false)
	if err != nil {
		return NigerianBankRailRuntimeConfig{}, err
	}
	executionEnabled, err := parseStrictBool(getenv, NigerianRailExecutionEnabledEnv, false)
	if err != nil {
		return NigerianBankRailRuntimeConfig{}, err
	}
	config := NigerianBankRailRuntimeConfig{Enabled: enabled, ExecutionEnabled: executionEnabled, Production: production, Timeout: defaultNigerianRailTimeout, MaxBodyBytes: defaultNigerianRailMaxBody}
	if executionEnabled && !enabled {
		return NigerianBankRailRuntimeConfig{}, errors.New("NIGERIAN_RAIL_EXECUTION_ENABLED cannot be true when NIGERIAN_RAIL_ENABLED is false")
	}
	if !enabled {
		return config, nil
	}
	config.BaseURL = strings.TrimSpace(getenv(NigerianRailBaseURLEnv))
	config.CABundle = strings.TrimSpace(getenv(NigerianRailCABundleEnv))
	if raw := strings.TrimSpace(getenv(NigerianRailTimeoutEnv)); raw != "" {
		config.Timeout, err = time.ParseDuration(raw)
		if err != nil {
			return NigerianBankRailRuntimeConfig{}, fmt.Errorf("%s must be a valid duration", NigerianRailTimeoutEnv)
		}
	}
	if raw := strings.TrimSpace(getenv(NigerianRailMaxBodyBytesEnv)); raw != "" {
		config.MaxBodyBytes, err = strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return NigerianBankRailRuntimeConfig{}, fmt.Errorf("%s must be a positive integer", NigerianRailMaxBodyBytesEnv)
		}
	}
	config.BearerToken, config.BearerTokenFile, err = readBearerToken(getenv)
	if err != nil {
		return NigerianBankRailRuntimeConfig{}, err
	}
	if err := ValidateNigerianRailConfig(config); err != nil {
		return NigerianBankRailRuntimeConfig{}, err
	}
	return config, nil
}

func ValidateNigerianRailConfig(config NigerianBankRailRuntimeConfig) error {
	if !config.Enabled {
		if config.ExecutionEnabled {
			return errors.New("Nigerian rail execution cannot be enabled while the rail is disabled")
		}
		return nil
	}
	if strings.TrimSpace(config.BaseURL) == "" {
		return errors.New("NIGERIAN_RAIL_BASE_URL is required when the rail is enabled")
	}
	if strings.TrimSpace(config.BearerToken) == "" {
		return errors.New("Nigerian rail bearer credential is required when the rail is enabled")
	}
	if config.Timeout <= 0 || config.Timeout > maxNigerianRailTimeout {
		return fmt.Errorf("%s must be greater than zero and no more than %s", NigerianRailTimeoutEnv, maxNigerianRailTimeout)
	}
	if config.MaxBodyBytes <= 0 || config.MaxBodyBytes > maxNigerianRailMaxBody {
		return fmt.Errorf("%s must be between 1 and %d", NigerianRailMaxBodyBytesEnv, maxNigerianRailMaxBody)
	}
	if config.CABundle != "" {
		if _, err := os.Stat(config.CABundle); err != nil {
			return errors.New("NIGERIAN_RAIL_CA_BUNDLE is unreadable")
		}
	}
	if config.BaseURL == "" {
		return nil
	}
	parsed, err := url.Parse(config.BaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("NIGERIAN_RAIL_BASE_URL must be an absolute credential-free URL")
	}
	if config.Production && parsed.Scheme != "https" {
		return errors.New("NIGERIAN_RAIL_BASE_URL must use HTTPS in production")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return errors.New("NIGERIAN_RAIL_BASE_URL must use HTTPS unless it is an explicit loopback test endpoint")
	}
	return nil
}
