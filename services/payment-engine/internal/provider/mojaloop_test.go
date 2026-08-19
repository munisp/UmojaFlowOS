package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const validTransferID = "019875da-8fd5-7edb-98ad-57b1744d1c8a"

type fixedMojaloopSigner struct {
	signature string
	err       error
	method    string
	uri       string
	body      []byte
}

func (s *fixedMojaloopSigner) SignFSPIOP(_ context.Context, method, requestURI string, body []byte) (string, error) {
	s.method, s.uri, s.body = method, requestURI, append([]byte(nil), body...)
	return s.signature, s.err
}

func validMojaloopInstruction() MojaloopInstruction {
	return MojaloopInstruction{
		InstructionID: validTransferID,
		Corridor:      "NIGERIA_NGN",
		Amount:        "100.25",
		Currency:      "NGN",
		PayerFSP:      "umojaflowos-ng",
		PayeeFSP:      "licensed-counterparty",
		Expiration:    time.Now().UTC().Add(5 * time.Minute),
		ILPPacket:     "AyAD",
		Condition:     "lB7gTCD0aA1ESQ0cW9vN4pK8FhSgQdHDitEMlJwoYMc",
	}
}

func TestDisabledMojaloopClientFailsClosed(t *testing.T) {
	instruction := validMojaloopInstruction()
	if err := ValidateInstruction(instruction); err != nil {
		t.Fatal(err)
	}
	if _, err := (DisabledMojaloopClient{}).SubmitTransfer(context.Background(), instruction); err == nil {
		t.Fatal("disabled Mojaloop client accepted a transfer")
	}
}

func TestFSPIOPClientSendsSignedAsynchronousTransferRequest(t *testing.T) {
	signer := &fixedMojaloopSigner{signature: "detached-signature"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/transfers" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		for header, expected := range map[string]string{
			"FSPIOP-Source":      "umojaflowos-ng",
			"FSPIOP-Destination": "licensed-counterparty",
			"FSPIOP-URI":         "/transfers",
			"FSPIOP-HTTP-Method": "POST",
			"FSPIOP-Signature":   "detached-signature",
		} {
			if actual := r.Header.Get(header); actual != expected {
				t.Fatalf("%s = %q, want %q", header, actual, expected)
			}
		}
		if !strings.Contains(r.Header.Get("Content-Type"), "version=1.1") {
			t.Fatalf("missing FSPIOP content type: %q", r.Header.Get("Content-Type"))
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["transferId"] != validTransferID || payload["payerFsp"] != "umojaflowos-ng" || payload["payeeFsp"] != "licensed-counterparty" {
			t.Fatalf("unexpected transfer payload: %#v", payload)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	client, err := NewFSPIOPMojaloopClient(MojaloopConfig{
		BaseURL:               server.URL,
		SourceFSP:             "umojaflowos-ng",
		Signer:                signer,
		AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	acceptedID, err := client.SubmitTransfer(context.Background(), validMojaloopInstruction())
	if err != nil {
		t.Fatal(err)
	}
	if acceptedID != validTransferID {
		t.Fatalf("accepted request id = %q, want %q", acceptedID, validTransferID)
	}
	if signer.method != http.MethodPost || signer.uri != "/transfers" || !strings.Contains(string(signer.body), validTransferID) {
		t.Fatalf("signer did not receive the exact FSPIOP request: %#v", signer)
	}
}

func TestFSPIOPClientFailsClosedForUnauthorizedAcceptanceConditions(t *testing.T) {
	for name, mutate := range map[string]func(*MojaloopConfig, *MojaloopInstruction){
		"remote plaintext": func(config *MojaloopConfig, _ *MojaloopInstruction) {
			config.BaseURL, config.AllowInsecureLoopback = "http://198.51.100.42:13000", true
		},
		"missing signer":   func(config *MojaloopConfig, _ *MojaloopInstruction) { config.Signer = nil },
		"invalid corridor": func(_ *MojaloopConfig, instruction *MojaloopInstruction) { instruction.Currency = "KES" },
		"expired request": func(_ *MojaloopConfig, instruction *MojaloopInstruction) {
			instruction.Expiration = time.Now().UTC().Add(-time.Minute)
		},
	} {
		t.Run(name, func(t *testing.T) {
			config := MojaloopConfig{BaseURL: "https://switch.example.test", SourceFSP: "umojaflowos-ng", Signer: &fixedMojaloopSigner{signature: "signature"}}
			instruction := validMojaloopInstruction()
			mutate(&config, &instruction)
			client, err := NewFSPIOPMojaloopClient(config)
			if err == nil {
				_, err = client.SubmitTransfer(context.Background(), instruction)
			}
			if err == nil {
				t.Fatal("unsafe Mojaloop request was accepted")
			}
		})
	}
}

func TestFSPIOPClientDoesNotClaimSettlementFromAcceptedRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer server.Close()
	client, err := NewFSPIOPMojaloopClient(MojaloopConfig{BaseURL: server.URL, SourceFSP: "umojaflowos-ng", Signer: &fixedMojaloopSigner{signature: "signature"}, AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.SubmitTransfer(context.Background(), validMojaloopInstruction()); err == nil {
		t.Fatal("HTTP 200 was treated as a settled or accepted transfer")
	}
}
