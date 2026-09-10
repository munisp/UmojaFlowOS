package settlement

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

var (
	routeTracer              = otel.Tracer("umoja/payment-engine/settlement/routing")
	routeDecisions           = mustRouteCounter()
	ErrCorridorUnavailable   = errors.New("no approved corridor route is available")
	ErrLiquidityUnavailable  = errors.New("liquidity evidence is unavailable")
	ErrLiquidityInsufficient = errors.New("available liquidity is below the required settlement buffer")
	ErrTreasuryStale         = errors.New("treasury evidence is stale")
)

type CorridorRoute struct {
	ID                  string
	TenantID            string
	OriginCountry       string
	DestinationCountry  string
	SourceCurrency      string
	DestinationCurrency string
	Direction           Direction
	Asset               string
	Rails               []string
	ProviderPriority    []string
	MinAmountMinor      int64
	MaxAmountMinor      int64
	QuoteTTL            time.Duration
	LiquidityBufferBps  int64
	SettlementCutoff    time.Time
	Enabled             bool
	Version             int64
}

type RouteDecision struct {
	Route      CorridorRoute
	Provider   string
	Rail       string
	ExpiresAt  time.Time
	PolicyHash string
}

type LiquidityEvidence struct {
	TenantID            string
	RouteID             string
	Provider            string
	Currency            string
	AvailableMinor      int64
	ReservedMinor       int64
	RequiredBufferMinor int64
	ObservedAt          time.Time
	ExpiresAt           time.Time
	EvidenceID          string
	Source              string
	EvidenceDigest      string
}

type LiquidityDecision struct {
	Allowed   bool
	Evidence  LiquidityEvidence
	Reason    string
	CheckedAt time.Time
}

func mustRouteCounter() metric.Int64Counter {
	counter, err := otel.Meter("umoja/payment-engine/settlement/routing").Int64Counter("umoja_settlement_route_decisions_total")
	if err != nil {
		panic(err)
	}
	return counter
}

type CorridorRouter interface {
	Route(context.Context, Intent) (RouteDecision, error)
}

type LiquidityVerifier interface {
	Verify(context.Context, Intent, RouteDecision) (LiquidityDecision, error)
}

// StaticCorridorRouter is suitable for deterministic local tests and for a
// configuration-backed production adapter. It never selects a disabled or
// mismatched route.
type StaticCorridorRouter struct {
	Routes []CorridorRoute
}

func (r StaticCorridorRouter) Route(ctx context.Context, in Intent) (RouteDecision, error) {
	ctx, span := routeTracer.Start(ctx, "settlement.route.select", trace.WithAttributes(
		attribute.String("tenant.id", in.TenantID),
		attribute.String("settlement.asset", in.Asset),
		attribute.String("settlement.currency", in.Fiat),
		attribute.String("settlement.direction", string(in.Direction)),
	))
	defer span.End()
	for _, route := range r.Routes {
		if !route.Enabled || route.TenantID != in.TenantID || route.Direction != in.Direction ||
			route.Asset != in.Asset || route.SourceCurrency != in.Fiat ||
			route.DestinationCountry != in.DestinationCountry {
			continue
		}
		if in.AmountMinor < route.MinAmountMinor || (route.MaxAmountMinor > 0 && in.AmountMinor > route.MaxAmountMinor) {
			continue
		}
		if len(route.ProviderPriority) == 0 || len(route.Rails) == 0 {
			continue
		}
		decision := RouteDecision{Route: route, Provider: route.ProviderPriority[0], Rail: route.Rails[0], ExpiresAt: time.Now().Add(route.QuoteTTL)}
		span.SetAttributes(attribute.String("corridor.route_id", route.ID), attribute.String("settlement.provider", decision.Provider), attribute.String("settlement.rail", decision.Rail), attribute.Bool("route.allowed", true))
		routeDecisions.Add(ctx, 1, metric.WithAttributes(attribute.String("tenant.id", in.TenantID), attribute.String("route.result", "allowed")))
		return decision, nil
	}
	span.SetAttributes(attribute.Bool("route.allowed", false))
	routeDecisions.Add(ctx, 1, metric.WithAttributes(attribute.String("tenant.id", in.TenantID), attribute.String("route.result", "denied")))
	return RouteDecision{}, ErrCorridorUnavailable
}

// EvidenceLiquidityVerifier enforces positive, fresh, non-negative treasury
// evidence. Any ambiguity is rejected before a ledger post is attempted.
type EvidenceLiquidityVerifier struct {
	Now func() time.Time
}

func (v EvidenceLiquidityVerifier) Verify(_ context.Context, in Intent, route RouteDecision) (LiquidityDecision, error) {
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	e := routeEvidence(route)
	if e.TenantID == "" || e.RouteID == "" || e.Provider == "" || e.Currency == "" || e.EvidenceID == "" {
		return LiquidityDecision{CheckedAt: now, Reason: "liquidity evidence identity is incomplete"}, ErrLiquidityUnavailable
	}
	if e.ObservedAt.IsZero() || e.ExpiresAt.IsZero() || !e.ExpiresAt.After(now) || e.ObservedAt.After(now) {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity evidence is stale or invalid"}, ErrTreasuryStale
	}
	if e.AvailableMinor < 0 || e.ReservedMinor < 0 || e.RequiredBufferMinor < 0 {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity evidence contains negative values"}, ErrLiquidityUnavailable
	}
	available := e.AvailableMinor - e.ReservedMinor
	if available < in.AmountMinor+e.RequiredBufferMinor {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity buffer is insufficient"}, ErrLiquidityInsufficient
	}
	return LiquidityDecision{Allowed: true, Evidence: e, CheckedAt: now, Reason: "fresh liquidity and treasury evidence verified"}, nil
}

func routeEvidence(route RouteDecision) LiquidityEvidence {
	return LiquidityEvidence{TenantID: route.Route.TenantID, RouteID: route.Route.ID, Provider: route.Provider, Currency: route.Route.SourceCurrency, EvidenceID: strings.TrimSpace(route.PolicyHash), ObservedAt: time.Now(), ExpiresAt: route.ExpiresAt}
}

type StaticLiquidityVerifier struct {
	Evidence LiquidityEvidence
	Now      func() time.Time
}

func (v StaticLiquidityVerifier) Verify(_ context.Context, in Intent, route RouteDecision) (LiquidityDecision, error) {
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	e := v.Evidence
	if e.TenantID == "" {
		e.TenantID = route.Route.TenantID
	}
	if e.RouteID == "" {
		e.RouteID = route.Route.ID
	}
	if e.Provider == "" {
		e.Provider = route.Provider
	}
	if e.Currency == "" {
		e.Currency = route.Route.SourceCurrency
	}
	if e.EvidenceID == "" {
		e.EvidenceID = "test-evidence"
	}
	if e.ObservedAt.IsZero() {
		e.ObservedAt = now
	}
	if e.ExpiresAt.IsZero() {
		e.ExpiresAt = now.Add(time.Hour)
	}
	if e.TenantID == "" || e.RouteID == "" || e.Provider == "" || e.Currency == "" {
		return LiquidityDecision{CheckedAt: now, Reason: "liquidity evidence identity is incomplete"}, ErrLiquidityUnavailable
	}
	if !e.ExpiresAt.After(now) || e.ObservedAt.After(now) {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity evidence is stale or invalid"}, ErrTreasuryStale
	}
	if e.AvailableMinor < 0 || e.ReservedMinor < 0 || e.RequiredBufferMinor < 0 {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity evidence contains negative values"}, ErrLiquidityUnavailable
	}
	if e.AvailableMinor-e.ReservedMinor < in.AmountMinor+e.RequiredBufferMinor {
		return LiquidityDecision{Evidence: e, CheckedAt: now, Reason: "liquidity buffer is insufficient"}, ErrLiquidityInsufficient
	}
	return LiquidityDecision{Allowed: true, Evidence: e, CheckedAt: now, Reason: "fresh liquidity and treasury evidence verified"}, nil
}
