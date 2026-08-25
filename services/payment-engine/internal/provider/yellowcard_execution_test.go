package provider

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type executionRoundTripper func(*http.Request) (*http.Response, error)

func (f executionRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type executionSigner struct{}

func (executionSigner) SignYellowCard(context.Context, []byte) (string, string, error) {
	return "key", "signature", nil
}

func validYellowCardSend() YellowCardSend {
	amount := int64(25)
	return YellowCardSend{
		SequenceID: "order-1001-leg-1", CustomerUID: "customer-1001", CustomerType: "institution",
		Reason: "approved invoice settlement", Amount: &amount, ChannelType: "bank", Country: "NG", Currency: "NGN",
		Sender:      YellowCardSenderDetails{BusinessID: "RC-1001", BusinessName: "Umoja Test Entity"},
		Destination: YellowCardDestination{AccountNumber: "0123456789", AccountType: "bank", NetworkID: "network-1", AccountName: "Approved Beneficiary"},
	}
}

func TestSubmitSendSignsDocumentedEndpointAndReturnsProvisionalReference(t *testing.T) {
	client, err := NewYellowCardClient(YellowCardConfig{
		BaseURL: "https://sandbox.api.yellowcard.example/business", Signer: executionSigner{},
		Now: func() time.Time { return time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC) },
		HTTPClient: &http.Client{Transport: executionRoundTripper(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/business/send" || request.Method != http.MethodPost {
				t.Fatalf("unexpected provider request %s %s", request.Method, request.URL.Path)
			}
			if request.Header.Get("Authorization") != "YcHmacV1 key:signature" || request.Header.Get("X-YC-Timestamp") == "" {
				t.Fatal("signed provider headers are required")
			}
			payload, _ := io.ReadAll(request.Body)
			if strings.Contains(string(payload), "\"forceAccept\":true") {
				t.Fatal("force accept must never be sent")
			}
			return &http.Response{StatusCode: http.StatusCreated, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"id":"provider-send-1","sequenceId":"order-1001-leg-1","status":"created","expiresAt":"2026-08-25T12:10:00Z"}`))}, nil
		})},
	})
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	result, err := client.SubmitSend(context.Background(), validYellowCardSend())
	if err != nil {
		t.Fatalf("submit send: %v", err)
	}
	if result.Reference != "provider-send-1" || result.Status != "created" {
		t.Fatalf("unexpected provisional result: %+v", result)
	}
}

func TestSubmitSendRejectsForceAcceptAndIncompleteSender(t *testing.T) {
	client, err := NewYellowCardClient(YellowCardConfig{BaseURL: "https://sandbox.api.yellowcard.example/business", Signer: executionSigner{}})
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	request := validYellowCardSend()
	request.ForceAccept = true
	if _, err := client.SubmitSend(context.Background(), request); err == nil {
		t.Fatal("force-accept request must be rejected")
	}
	request = validYellowCardSend()
	request.CustomerType = "retail"
	request.Sender = YellowCardSenderDetails{}
	if _, err := client.SubmitSend(context.Background(), request); err == nil {
		t.Fatal("incomplete retail sender must be rejected")
	}
}

func TestSubmitSendRequiresExactlyOneAmount(t *testing.T) {
	client, err := NewYellowCardClient(YellowCardConfig{BaseURL: "https://sandbox.api.yellowcard.example/business", Signer: executionSigner{}})
	if err != nil {
		t.Fatalf("construct client: %v", err)
	}
	request := validYellowCardSend()
	other := int64(30)
	request.LocalAmount = &other
	if _, err := client.SubmitSend(context.Background(), request); err == nil {
		t.Fatal("both amount fields must be rejected")
	}
}
