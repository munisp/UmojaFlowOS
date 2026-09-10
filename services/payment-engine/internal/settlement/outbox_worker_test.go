package settlement

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
)

type outboxStoreFake struct {
	events               []OutboxEvent
	claimedTenant, owner string
	marked               []string
	claimErr, markErr    error
}

func (s *outboxStoreFake) ClaimOutbox(_ context.Context, tenant, owner string, _ int, _ time.Duration) ([]OutboxEvent, error) {
	s.claimedTenant = tenant
	s.owner = owner
	return s.events, s.claimErr
}
func (s *outboxStoreFake) MarkOutboxPublished(_ context.Context, tenant, eventID, owner string) error {
	s.marked = append(s.marked, tenant+":"+eventID+":"+owner)
	return s.markErr
}

type eventPublisherFake struct {
	envelopes []eventing.Envelope
	err       error
}

func (p *eventPublisherFake) Publish(_ context.Context, _ string, e eventing.Envelope) error {
	p.envelopes = append(p.envelopes, e)
	return p.err
}
func validOutboxEvent() OutboxEvent {
	payload := []byte(`{"tenant_id":"tenant-a","saga_id":"saga-1","stage":"screened"}`)
	return OutboxEvent{TenantID: "tenant-a", EventID: "event-1", SagaID: "saga-1", Stage: StageScreened, EventType: "umojaflowos.settlement.saga-transition.v1", Payload: payload, PayloadSHA256: PayloadDigest(payload), AvailableAt: time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)}
}
func TestOutboxWorkerPublishesOnlyValidatedTenantEvents(t *testing.T) {
	store := &outboxStoreFake{events: []OutboxEvent{validOutboxEvent()}}
	publisher := &eventPublisherFake{}
	worker := OutboxWorker{Store: store, Publisher: publisher, Topic: "settlement-events", Owner: "worker-a", BatchSize: 10, Lease: time.Minute}
	count, err := worker.PublishOnce(context.Background(), "tenant-a")
	if err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	if store.claimedTenant != "tenant-a" || len(publisher.envelopes) != 1 || publisher.envelopes[0].CorrelationID != "saga-1" || len(store.marked) != 1 {
		t.Fatalf("store=%+v envelopes=%+v", store, publisher.envelopes)
	}
}
func TestOutboxWorkerDoesNotAcknowledgeBrokerFailure(t *testing.T) {
	store := &outboxStoreFake{events: []OutboxEvent{validOutboxEvent()}}
	publisher := &eventPublisherFake{err: errors.New("kafka unavailable")}
	worker := OutboxWorker{Store: store, Publisher: publisher, Topic: "settlement-events", Owner: "worker-a", BatchSize: 10, Lease: time.Minute}
	count, err := worker.PublishOnce(context.Background(), "tenant-a")
	if err == nil || count != 0 || len(store.marked) != 0 {
		t.Fatalf("count=%d err=%v marked=%v", count, err, store.marked)
	}
}
func TestOutboxWorkerRejectsCrossTenantAndTamperedPayload(t *testing.T) {
	event := validOutboxEvent()
	event.TenantID = "tenant-b"
	store := &outboxStoreFake{events: []OutboxEvent{event}}
	publisher := &eventPublisherFake{}
	worker := OutboxWorker{Store: store, Publisher: publisher, Topic: "settlement-events", Owner: "worker-a", BatchSize: 10, Lease: time.Minute}
	if _, err := worker.PublishOnce(context.Background(), "tenant-a"); err == nil || len(publisher.envelopes) != 0 || len(store.marked) != 0 {
		t.Fatalf("cross-tenant event must be rejected: err=%v", err)
	}
	event = validOutboxEvent()
	event.Payload = []byte(`{"changed":true}`)
	store.events = []OutboxEvent{event}
	if _, err := worker.PublishOnce(context.Background(), "tenant-a"); err == nil || len(store.marked) != 0 {
		t.Fatalf("tampered payload must be rejected: err=%v", err)
	}
}
