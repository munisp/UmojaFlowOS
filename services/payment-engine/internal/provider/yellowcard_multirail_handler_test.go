package provider

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

type recordingUnknownStore struct{ states []multirail.UnknownState }

func (s *recordingUnknownStore) EnqueueUnknown(_ context.Context, state multirail.UnknownState) error {
	s.states = append(s.states, state)
	return nil
}

type recordingSecondaryRail struct{ calls int }

func (r *recordingSecondaryRail) Name() string { return "nigerian_bank" }
func (r *recordingSecondaryRail) Submit(context.Context, multirail.Intent) (multirail.Submission, error) {
	r.calls++
	return multirail.Submission{Status: multirail.Submitted}, nil
}
func (r *recordingSecondaryRail) Query(context.Context, multirail.Intent) (multirail.Submission, error) {
	return multirail.Submission{Status: multirail.Unknown}, nil
}

func TestCoordinatedYellowCardHandlerKeepsPrimaryProvisional(t *testing.T) {
	yc, err := NewYellowCardClient(YellowCardConfig{
		BaseURL: "https://sandbox.api.yellowcard.example/business", Signer: executionSigner{},
		Now: func() time.Time { return time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC) },
		HTTPClient: &http.Client{Transport: executionRoundTripper(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.URL.Path != "/business/send" {
				t.Fatalf("unexpected primary request %s %s", request.Method, request.URL.Path)
			}
			return &http.Response{StatusCode: http.StatusCreated, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"id":"provider-send-1","sequenceId":"order-1001-leg-1","status":"created"}`))}, nil
		})},
	})
	if err != nil {
		t.Fatal(err)
	}
	secondary := &recordingSecondaryRail{}
	store := &recordingUnknownStore{}
	handler, err := NewCoordinatedYellowCardExecutionHandler(yc, []byte("0123456789abcdef"), multirail.NewCoordinator(), secondary, store, func() time.Time { return time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC) }, 5*time.Minute, 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, signedExecutionRequest(t, []byte("0123456789abcdef"), time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC), validYellowCardSend()))
	if response.Code != http.StatusAccepted || secondary.calls != 0 || len(store.states) != 0 {
		t.Fatalf("status=%d secondary=%d queued=%d", response.Code, secondary.calls, len(store.states))
	}
}

func TestCoordinatedYellowCardHandlerQueuesTransportUnknown(t *testing.T) {
	yc, err := NewYellowCardClient(YellowCardConfig{
		BaseURL: "https://sandbox.api.yellowcard.example/business", Signer: executionSigner{},
		HTTPClient: &http.Client{Transport: executionRoundTripper(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })},
	})
	if err != nil {
		t.Fatal(err)
	}
	secondary := &recordingSecondaryRail{}
	store := &recordingUnknownStore{}
	handler, err := NewCoordinatedYellowCardExecutionHandler(yc, []byte("0123456789abcdef"), multirail.NewCoordinator(), secondary, store, time.Now, 5*time.Minute, 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, signedExecutionRequest(t, []byte("0123456789abcdef"), time.Now().UTC(), validYellowCardSend()))
	if response.Code != http.StatusServiceUnavailable || secondary.calls != 0 || len(store.states) != 1 {
		t.Fatalf("status=%d secondary=%d queued=%d", response.Code, secondary.calls, len(store.states))
	}
}
