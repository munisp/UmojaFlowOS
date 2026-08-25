package provider

import (
	"context"
	"testing"
)

func TestExecutionRuntimeIsDisabledByDefault(t *testing.T) {
	runtime, err := YellowCardExecutionRuntimeFromEnvironment(context.Background(), func(string) string { return "" })
	if err != nil {
		t.Fatalf("disabled runtime should not error: %v", err)
	}
	if runtime.Enabled {
		t.Fatal("execution runtime must remain disabled without an explicit feature flag")
	}
	if _, err := runtime.Sender.SubmitSend(context.Background(), validYellowCardSend()); err == nil {
		t.Fatal("disabled execution runtime must reject provider Sends")
	}
}

func TestExecutionRuntimeRejectsUnsafeForceAccept(t *testing.T) {
	env := map[string]string{
		"UMOJA_YELLOWCARD_EXECUTION_ENABLED":  "true",
		"UMOJA_YELLOWCARD_ENABLED":            "true",
		"UMOJA_YELLOWCARD_ENVIRONMENT":        "sandbox",
		"UMOJA_YELLOWCARD_ALLOW_FORCE_ACCEPT": "true",
	}
	_, err := YellowCardExecutionRuntimeFromEnvironment(context.Background(), func(key string) string { return env[key] })
	if err == nil {
		t.Fatal("force-accept configuration must be rejected before resolving provider secrets")
	}
}
