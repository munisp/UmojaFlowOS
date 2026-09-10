package settlement

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// PostgresCorridorRouter reads the approved, tenant-isolated policy table.
// It rejects multiple matching enabled routes rather than selecting an
// arbitrary one. A policy author must make the intended route unambiguous.
type PostgresCorridorRouter struct {
	DB  *sql.DB
	Now func() time.Time
}

func (r *PostgresCorridorRouter) now() time.Time {
	if r != nil && r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func (r *PostgresCorridorRouter) Route(ctx context.Context, in Intent) (RouteDecision, error) {
	if r == nil || r.DB == nil {
		return RouteDecision{}, ErrCorridorUnavailable
	}
	if err := validateIntent(in); err != nil {
		return RouteDecision{}, err
	}
	if len(strings.TrimSpace(in.OriginCountry)) != 2 || len(strings.TrimSpace(in.DestinationCountry)) != 2 {
		return RouteDecision{}, ErrCorridorUnavailable
	}
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return RouteDecision{}, fmt.Errorf("open corridor route transaction: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `SELECT set_config('umoja.tenant_id',$1,true)`, in.TenantID); err != nil {
		return RouteDecision{}, fmt.Errorf("bind corridor tenant: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT route_id,tenant_id,origin_country,destination_country,source_currency,destination_currency,direction,asset,rails,provider_priority,min_amount_minor,COALESCE(max_amount_minor,0),quote_ttl_seconds,liquidity_buffer_bps,settlement_cutoff,enabled,version
		FROM corridor_routes
		WHERE tenant_id=$1 AND enabled=true AND origin_country=$2 AND destination_country=$3 AND source_currency=$4 AND direction=$5 AND asset=$6
		  AND $7 BETWEEN min_amount_minor AND COALESCE(max_amount_minor,9223372036854775807)
		  AND ($8='' OR route_id=$8)
		ORDER BY route_id
		LIMIT 2`, in.TenantID, strings.ToUpper(in.OriginCountry), strings.ToUpper(in.DestinationCountry), strings.ToUpper(in.Fiat), string(in.Direction), strings.ToUpper(in.Asset), in.AmountMinor, strings.TrimSpace(in.CorridorID))
	if err != nil {
		return RouteDecision{}, fmt.Errorf("read corridor policy: %w", err)
	}
	defer rows.Close()
	var found []CorridorRoute
	for rows.Next() {
		var route CorridorRoute
		var direction string
		var railsJSON, providersJSON []byte
		var cutoff sql.NullTime
		var quoteSeconds int64
		if err := rows.Scan(&route.ID, &route.TenantID, &route.OriginCountry, &route.DestinationCountry, &route.SourceCurrency, &route.DestinationCurrency, &direction, &route.Asset, &railsJSON, &providersJSON, &route.MinAmountMinor, &route.MaxAmountMinor, &quoteSeconds, &route.LiquidityBufferBps, &cutoff, &route.Enabled, &route.Version); err != nil {
			return RouteDecision{}, err
		}
		route.Direction = Direction(direction)
		route.QuoteTTL = time.Duration(quoteSeconds) * time.Second
		if cutoff.Valid {
			route.SettlementCutoff = cutoff.Time.UTC()
		}
		if err := json.Unmarshal(railsJSON, &route.Rails); err != nil {
			return RouteDecision{}, fmt.Errorf("decode corridor rails: %w", err)
		}
		if err := json.Unmarshal(providersJSON, &route.ProviderPriority); err != nil {
			return RouteDecision{}, fmt.Errorf("decode corridor provider priority: %w", err)
		}
		if !validRoutePolicy(route) {
			return RouteDecision{}, ErrCorridorUnavailable
		}
		found = append(found, route)
	}
	if err := rows.Err(); err != nil {
		return RouteDecision{}, err
	}
	if len(found) != 1 {
		return RouteDecision{}, ErrCorridorUnavailable
	}
	if err := tx.Commit(); err != nil {
		return RouteDecision{}, err
	}
	route := found[0]
	if !route.SettlementCutoff.IsZero() && !r.now().Before(route.SettlementCutoff) {
		return RouteDecision{}, ErrCorridorUnavailable
	}
	policyHash := hashRoutePolicy(route)
	return RouteDecision{Route: route, Provider: route.ProviderPriority[0], Rail: route.Rails[0], ExpiresAt: r.now().Add(route.QuoteTTL), PolicyHash: policyHash}, nil
}
func validRoutePolicy(route CorridorRoute) bool {
	return route.Enabled && strings.TrimSpace(route.ID) != "" && strings.TrimSpace(route.TenantID) != "" && len(route.Rails) > 0 && len(route.ProviderPriority) > 0 && strings.TrimSpace(route.Rails[0]) != "" && strings.TrimSpace(route.ProviderPriority[0]) != "" && route.QuoteTTL > 0
}
func hashRoutePolicy(route CorridorRoute) string {
	bytes, err := json.Marshal(route)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:])
}

var _ CorridorRouter = (*PostgresCorridorRouter)(nil)
