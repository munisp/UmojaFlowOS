package provider

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultMojaloopSignerMaxAttempts  = 3
	defaultMojaloopSignerInitialDelay = 25 * time.Millisecond
	defaultMojaloopSignerMaxDelay     = 250 * time.Millisecond
	maxMojaloopSignerAttempts         = 5
	maxMojaloopSignerBackoff          = 2 * time.Second
)

// LoadMojaloopSignerRetryPolicy reads the production retry policy. The loader
// fails closed when Mojaloop execution is enabled and a configured value is
// malformed or outside the bounded policy.
func LoadMojaloopSignerRetryPolicy(getenv func(string) string) (SignerRetryPolicy, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	policy := SignerRetryPolicy{
		MaxAttempts:  defaultMojaloopSignerMaxAttempts,
		InitialDelay: defaultMojaloopSignerInitialDelay,
		MaxDelay:     defaultMojaloopSignerMaxDelay,
	}
	if strings.EqualFold(strings.TrimSpace(getenv("MOJALOOP_FSPIOP_ENABLED")), "false") || strings.TrimSpace(getenv("MOJALOOP_FSPIOP_ENABLED")) == "" {
		return policy, nil
	}
	var err error
	if raw := strings.TrimSpace(getenv("MOJALOOP_FSPIOP_SIGNER_MAX_ATTEMPTS")); raw != "" {
		policy.MaxAttempts, err = strconv.Atoi(raw)
		if err != nil || policy.MaxAttempts < 1 || policy.MaxAttempts > maxMojaloopSignerAttempts {
			return SignerRetryPolicy{}, fmt.Errorf("MOJALOOP_FSPIOP_SIGNER_MAX_ATTEMPTS must be an integer from 1 to %d", maxMojaloopSignerAttempts)
		}
	}
	if raw := strings.TrimSpace(getenv("MOJALOOP_FSPIOP_SIGNER_INITIAL_BACKOFF")); raw != "" {
		policy.InitialDelay, err = time.ParseDuration(raw)
		if err != nil || policy.InitialDelay <= 0 || policy.InitialDelay > maxMojaloopSignerBackoff {
			return SignerRetryPolicy{}, fmt.Errorf("MOJALOOP_FSPIOP_SIGNER_INITIAL_BACKOFF must be a positive duration no greater than %s", maxMojaloopSignerBackoff)
		}
	}
	if raw := strings.TrimSpace(getenv("MOJALOOP_FSPIOP_SIGNER_MAX_BACKOFF")); raw != "" {
		policy.MaxDelay, err = time.ParseDuration(raw)
		if err != nil || policy.MaxDelay <= 0 || policy.MaxDelay > maxMojaloopSignerBackoff {
			return SignerRetryPolicy{}, fmt.Errorf("MOJALOOP_FSPIOP_SIGNER_MAX_BACKOFF must be a positive duration no greater than %s", maxMojaloopSignerBackoff)
		}
	}
	if policy.MaxDelay < policy.InitialDelay {
		return SignerRetryPolicy{}, errors.New("MOJALOOP_FSPIOP_SIGNER_MAX_BACKOFF must be greater than or equal to initial backoff")
	}
	if raw := strings.TrimSpace(getenv("MOJALOOP_FSPIOP_SIGNER_RETRY_TRANSIENT_ONLY")); raw != "" && !strings.EqualFold(raw, "true") {
		return SignerRetryPolicy{}, errors.New("MOJALOOP_FSPIOP_SIGNER_RETRY_TRANSIENT_ONLY must remain true")
	}
	return policy, nil
}
