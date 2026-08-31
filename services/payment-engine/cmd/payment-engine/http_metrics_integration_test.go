package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/provider"
)

func TestMetricsEndpointsWithoutExternalDependencies(t *testing.T) {
	signerMetrics := &provider.SignerRetryMetrics{}
	signerMetrics.AttemptsTotal.Store(12)
	signerMetrics.RetriesTotal.Store(4)
	signerMetrics.RetryExhaustedTotal.Store(2)
	signerMetrics.NonRetryableErrorsTotal.Store(1)

	handler := newHandlerWithSignerMetrics(time.Now, nil, nil, nil, signerMetrics)

	tests := []struct {
		name       string
		path       string
		contentType string
		expected   []string
	}{
		{
			name:       "json metrics",
			path:       "/v1/metrics",
			contentType: "application/json",
			expected:   []string{"\"signer_attempts_total\":12", "\"signer_retry_exhausted_total\":2"},
		},
		{
			name:       "prometheus metrics",
			path:       "/metrics",
			contentType: "text/plain",
			expected:   []string{"# TYPE umoja_signer_attempts_total counter", "umoja_signer_retries_total 4", "umoja_signer_retry_exhausted_total 2", "umoja_signer_non_retryable_errors_total 1"},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, testCase.path, nil)
			handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
			}
			if !strings.Contains(recorder.Header().Get("Content-Type"), testCase.contentType) {
				t.Fatalf("content type = %q, want %q", recorder.Header().Get("Content-Type"), testCase.contentType)
			}
			for _, expected := range testCase.expected {
				if !strings.Contains(recorder.Body.String(), expected) {
					t.Fatalf("response missing %q: %s", expected, recorder.Body.String())
				}
			}
		})
	}
}
