package authorization

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
)

type evidencePublisher struct {
	topic string
	event eventing.Envelope
}

func (p *evidencePublisher) Publish(_ context.Context, topic string, event eventing.Envelope) error {
	p.topic = topic
	p.event = event
	return nil
}

func loopbackConfig(baseURL string) Config {
	return Config{
		BaseURL:               baseURL,
		TenantID:              "t1",
		Timeout:               3 * time.Second,
		AllowInsecureLoopback: true,
	}
}

func TestPlaintextIsRefusedForRemoteHosts(t *testing.T) {
	_, err := NewClient(Config{BaseURL: "http://permify.example.com", TenantID: "t1", AllowInsecureLoopback: true})
	if err == nil {
		t.Fatal("plaintext to a remote authorization service must be refused")
	}
	if _, err := NewClient(Config{BaseURL: "https://permify.example.com", TenantID: "t1"}); err != nil {
		t.Fatalf("TLS to a remote host must be accepted: %v", err)
	}
	if _, err := NewClient(Config{BaseURL: "http://127.0.0.1:3476", TenantID: "t1"}); err == nil {
		t.Fatal("loopback plaintext must require the explicit exemption")
	}
}

func TestCredentialsInTheUrlAreRefused(t *testing.T) {
	_, err := NewClient(Config{BaseURL: "https://user:pass@permify.example.com", TenantID: "t1"})
	if err == nil {
		t.Fatal("a url embedding credentials must be refused")
	}
}

// Every failure mode must deny. These are the cases that determine whether the
// system fails open, so each is asserted separately rather than as a group.
func TestEveryFailureModeDenies(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"server error", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusInternalServerError) }},
		{"unauthorised", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) }},
		{"not json", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("<html>nope</html>")) }},
		{"empty body", func(w http.ResponseWriter, r *http.Request) {}},
		{"unknown result", func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"can":"CHECK_RESULT_SOMETHING_NEW"}`))
		}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(testCase.handler)
			defer server.Close()

			client, err := NewClient(loopbackConfig(server.URL))
			if err != nil {
				t.Fatalf("client: %v", err)
			}
			result := client.Check(context.Background(), Request{
				SubjectID: "u1", EntityType: "payment_order", EntityID: "o1", Permission: "approve_compliance",
			})
			if result.Decision != Denied {
				t.Fatalf("%s must deny, got %+v", testCase.name, result)
			}
			if !result.Indeterminate {
				t.Fatalf("%s should be marked indeterminate so it can be alerted on, got %+v", testCase.name, result)
			}
		})
	}
}

func TestUnreachableServiceDenies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	address := server.URL
	server.Close() // nothing is listening now

	client, err := NewClient(loopbackConfig(address))
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	result := client.Check(context.Background(), Request{
		SubjectID: "u1", EntityType: "payment_order", EntityID: "o1", Permission: "approve_compliance",
	})
	if result.Decision != Denied || !result.Indeterminate {
		t.Fatalf("an unreachable authorization service must deny, got %+v", result)
	}
}

func TestTimeoutDenies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		_, _ = w.Write([]byte(`{"can":"CHECK_RESULT_ALLOWED"}`))
	}))
	defer server.Close()

	config := loopbackConfig(server.URL)
	config.Timeout = 50 * time.Millisecond
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("client: %v", err)
	}

	result := client.Check(context.Background(), Request{
		SubjectID: "u1", EntityType: "payment_order", EntityID: "o1", Permission: "approve_compliance",
	})
	if result.Decision != Denied {
		t.Fatalf("a slow authorization service must deny rather than block, got %+v", result)
	}
}

func TestIncompleteRequestDenies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("an incomplete request must be refused before any network call")
	}))
	defer server.Close()

	client, err := NewClient(loopbackConfig(server.URL))
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	if result := client.Check(context.Background(), Request{EntityType: "payment_order"}); result.Decision != Denied {
		t.Fatalf("an incomplete request must deny, got %+v", result)
	}
}

func TestPermifyDecisionEvidenceIsRedactedAndCannotChangeAuthorization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"can":"CHECK_RESULT_ALLOWED"}`))
	}))
	defer server.Close()
	publisher := &evidencePublisher{}
	config := loopbackConfig(server.URL)
	config.EvidencePublisher = publisher
	config.EvidenceTopic = "payment.events"
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	result := client.Check(context.Background(), Request{
		SubjectType: "user", SubjectID: "operator-123", EntityType: "payment_order", EntityID: "order-123", Permission: "approve_compliance",
	})
	if result.Decision != Allowed {
		t.Fatalf("expected explicit allow, got %+v", result)
	}
	if publisher.topic != "payment.events" || publisher.event.EventType != eventing.PermifyDecisionV1 {
		t.Fatalf("unexpected authorization evidence event: %#v", publisher)
	}
	if strings.Contains(string(publisher.event.Payload), "operator") || strings.Contains(string(publisher.event.Payload), "order") || strings.Contains(string(publisher.event.Payload), "permission") {
		t.Fatalf("authorization evidence payload must not expose relationships: %s", publisher.event.Payload)
	}
}

// Live regression against the running Permify server. The schema and tuples
// are written by the test itself, so it proves the whole path: schema, data,
// and check.
func TestLivePermifyEnforcesTheSchema(t *testing.T) {
	baseURL := os.Getenv("PERMIFY_LIVE_URL")
	if baseURL == "" {
		t.Skip("set PERMIFY_LIVE_URL to run the live authorization regression")
	}

	client, err := NewClient(loopbackConfig(baseURL))
	if err != nil {
		t.Fatalf("client: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// A compliance officer of the owning organisation may approve.
	allowed := client.Check(ctx, Request{
		SubjectID: "u1", EntityType: "payment_order", EntityID: "o1", Permission: "approve_compliance",
	})
	if allowed.Decision != Allowed {
		t.Fatalf("expected the live schema to allow the compliance officer, got %+v", allowed)
	}

	// The same subject holds no treasury permission: role separation is
	// enforced by the authorization service, not by the caller.
	denied := client.Check(ctx, Request{
		SubjectID: "u1", EntityType: "payment_order", EntityID: "o1", Permission: "manage_treasury",
	})
	if denied.Decision != Denied {
		t.Fatalf("a compliance officer must not hold treasury permission, got %+v", denied)
	}
	if denied.Indeterminate {
		t.Fatal("an explicit policy denial must not be reported as indeterminate")
	}
	if !strings.Contains(denied.Reason, "policy") {
		t.Fatalf("a policy denial should say so, got %q", denied.Reason)
	}

	// An unrelated subject holds nothing at all: deny by default.
	unknown := client.Check(ctx, Request{
		SubjectID: "no-such-user", EntityType: "payment_order", EntityID: "o1", Permission: "approve_compliance",
	})
	if unknown.Decision != Denied {
		t.Fatalf("an unknown subject must be denied, got %+v", unknown)
	}
}
