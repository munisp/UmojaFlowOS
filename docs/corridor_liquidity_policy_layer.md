# Corridor and Liquidity Policy Layer

## Purpose

The corridor policy layer selects an approved rail and provider for a tenant, origin/destination corridor, asset, currency, direction, and amount. The liquidity layer verifies fresh treasury evidence before the ledger is allowed to post. Missing, stale, contradictory, or insufficient evidence holds the settlement and prevents ledger release.

## Execution order

```text
validate intent
  -> compliance screening
  -> corridor route selection
  -> liquidity and treasury verification
  -> ledger post
  -> attestation
  -> attestation verification
  -> settled
```

The coordinator never calls `Ledger.Post` when route selection or liquidity verification fails.

## Go contract

The settlement coordinator now requires:

```go
type CorridorRouter interface {
    Route(context.Context, Intent) (RouteDecision, error)
}

type LiquidityVerifier interface {
    Verify(context.Context, Intent, RouteDecision) (LiquidityDecision, error)
}
```

The production composition must provide both dependencies. A missing dependency returns a held/error result before any ledger call.

## Routing fields

| Field | Meaning |
|---|---|
| `route_id` | Stable route-policy identifier. |
| `tenant_id` | Tenant isolation binding. |
| `origin_country` | ISO-3166 alpha-2 origin country. |
| `destination_country` | ISO-3166 alpha-2 beneficiary country. |
| `source_currency` | ISO-4217 source currency. |
| `destination_currency` | ISO-4217 destination currency. |
| `direction` | `onramp` or `offramp`. |
| `asset` | Approved stablecoin or settlement asset. |
| `rails` | Ordered/approved rail identifiers. |
| `provider_priority` | Ordered provider failover candidates. |
| `min_amount_minor` | Inclusive lower amount bound. |
| `max_amount_minor` | Optional inclusive upper amount bound. |
| `quote_ttl_seconds` | Quote validity window. |
| `liquidity_buffer_bps` | Required treasury buffer policy. |
| `settlement_cutoff` | Optional corridor cutoff. |
| `enabled` | Disabled routes are never selected. |
| `version` | Optimistic policy version. |

## Liquidity evidence

Evidence is tenant-bound and includes available balance, reserved balance, required buffer, observation time, expiration, provider, source, and a SHA-256 digest. Admission requires:

```text
available_minor - reserved_minor >= amount_minor + required_buffer_minor
observed_at <= now < expires_at
available_minor >= 0
reserved_minor >= 0
required_buffer_minor >= 0
```

Any missing identity field, stale timestamp, negative amount, or insufficient balance fails closed.

## Persistence

Migration `0061_corridor_liquidity_policy.sql` creates:

```text
corridor_routes
liquidity_treasury_evidence
```

Both tables have tenant-scoped PostgreSQL RLS policies using `umoja.tenant_id`. The application role must not bypass RLS.

## Fail-closed result mapping

| Failure | Coordinator result |
|---|---|
| No route | `held`, `ErrCorridorUnavailable` |
| Missing liquidity verifier | error before ledger post |
| Missing evidence identity | `held`, `ErrLiquidityUnavailable` |
| Stale evidence | `held`, `ErrTreasuryStale` |
| Negative evidence | `held`, `ErrLiquidityUnavailable` |
| Insufficient available liquidity | `held`, `ErrLiquidityInsufficient` |
| Ledger error after admission | `unknown`, existing `ErrUnknown` |

## Configuration

The operator example is:

```text
config/corridors.example.yaml
```

It is intentionally configuration-only and contains no credentials. Production configuration must be loaded through the platform’s authenticated configuration/secrets mechanism and must be validated before enabling a route.
