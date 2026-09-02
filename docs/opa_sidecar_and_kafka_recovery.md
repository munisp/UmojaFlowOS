# OPA Sidecar Production Configuration and Kafka Recovery Loop

## Scope

This note documents production configuration for the Open Policy Agent sidecar used by the stablecoin reconciliation consumer and a complete fail-closed recovery loop for OPA timeouts, transport failures, malformed responses, and policy denials.

The central invariant is:

> No successful OPA decision means no TigerBeetle posting and no settlement completion.

A durable `UNKNOWN` record may be acknowledged by Kafka only after PostgreSQL has safely recorded the blocked state. If that durable write fails, the Kafka offset is not committed.

## 1. Helm values

Add the following values under `idem.opa` in `deploy/helm/umoja-payment-engine/values.yaml`:

```yaml
idem:
  enabled: true
  reconciliationTopic: umoja.stablecoin.v1.finality-confirmed
  opa:
    enabled: true
    image: openpolicyagent/opa:0.70.0
    imagePullPolicy: IfNotPresent
    endpoint: http://127.0.0.1:8181/v1/data/umojaflowos/stablecoin/result
    policyConfigMap: umoja-stablecoin-intent-policy
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 250m
        memory: 256Mi
    startupProbe:
      httpGet:
        path: /health?bundles=true
        port: opa-http
      periodSeconds: 2
      timeoutSeconds: 2
      failureThreshold: 30
    readinessProbe:
      httpGet:
        path: /health?bundles=true
        port: opa-http
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 3
      successThreshold: 1
    livenessProbe:
      httpGet:
        path: /health
        port: opa-http
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 2
      failureThreshold: 3
```

The policy image should be pinned by digest in production rather than by tag. The value shown above is suitable for a chart example; promotion should replace it with the approved immutable digest.

## 2. OPA sidecar template

Replace the current OPA container block in `deploy/helm/umoja-payment-engine/templates/deployment.yaml` with:

```yaml
        {{- if .Values.idem.opa.enabled }}
        - name: opa
          image: {{ .Values.idem.opa.image | quote }}
          imagePullPolicy: {{ .Values.idem.opa.imagePullPolicy | default "IfNotPresent" }}
          args:
            - run
            - --server
            - --addr=127.0.0.1:8181
            - --diagnostic-addr=127.0.0.1:8282
            - --set=decision_logs.console=false
            - /policy/umojaflowos_stablecoin_intent.rego
          ports:
            - name: opa-http
              containerPort: 8181
              protocol: TCP
          volumeMounts:
            - name: stablecoin-intent-policy
              mountPath: /policy
              readOnly: true
          startupProbe:
            httpGet:
              path: /health?bundles=true
              port: opa-http
            periodSeconds: 2
            timeoutSeconds: 2
            failureThreshold: 30
          readinessProbe:
            httpGet:
              path: /health?bundles=true
              port: opa-http
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 3
            successThreshold: 1
          livenessProbe:
            httpGet:
              path: /health
              port: opa-http
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 2
            failureThreshold: 3
          resources:
            {{- toYaml .Values.idem.opa.resources | nindent 12 }}
          securityContext:
            {{- toYaml .Values.securityContext.container | nindent 12 }}
        {{- end }}
```

The `startupProbe` allows policy loading to complete without causing premature liveness restarts. The readiness probe uses `bundles=true`, so the sidecar is not considered ready until its policy data is available. The application still treats an OPA request failure as deny; readiness is an operational signal and is not a security decision.

Recommended pod-level additions:

```yaml
      containers:
        - name: payment-engine
          # existing configuration
        - name: opa
          # block above
      volumes:
        - name: stablecoin-intent-policy
          configMap:
            name: {{ .Values.idem.opa.policyConfigMap }}
            items:
              - key: umojaflowos_stablecoin_intent.rego
                path: umojaflowos_stablecoin_intent.rego
```

The ConfigMap should be immutable:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: umoja-stablecoin-intent-policy
  labels:
    app.kubernetes.io/component: policy
immutable: true
data:
  umojaflowos_stablecoin_intent.rego: |
    # approved policy content is rendered here by the release process
```

## 3. Go recovery loop

The following implementation is designed to replace the current `Consume` loop while preserving the existing `Consumer`, `ReconciliationStore`, `IntentPolicy`, and `AuthoritativeLedger` interfaces.

```go
package reconciliation

import (
    "context"
    "errors"
    "fmt"
    "net"
    "strings"
    "time"

    "github.com/twmb/franz-go/pkg/kgo"
)

const (
    opaEvaluationTimeout = 750 * time.Millisecond
    opaRetryAttempts     = 3
    opaRetryBaseDelay    = 50 * time.Millisecond
)

type OPARecoveryMetrics interface {
    IncEvaluationFailure(reason string)
    IncEvaluationTimeout()
    IncPolicyDeny(reason string)
    IncUnknownPersistFailure()
}

type Consumer struct {
    Client  *kgo.Client
    Topic   string
    Store   ReconciliationStore
    Ledger  AuthoritativeLedger
    Policy  IntentPolicy
    Now     func() time.Time
    Metrics OPARecoveryMetrics
}

func (c *Consumer) Consume(ctx context.Context) error {
    if c == nil || c.Client == nil || c.Store == nil || c.Ledger == nil ||
        c.Policy == nil || strings.TrimSpace(c.Topic) == "" {
        return errors.New("Kafka consumer, topic, store, policy, and TigerBeetle ledger are required")
    }

    for {
        fetches := c.Client.PollFetches(ctx)
        if errs := fetches.Errors(); len(errs) != 0 {
            return fmt.Errorf("Kafka fetch failed: %v", errs)
        }
        if err := ctx.Err(); err != nil {
            return err
        }

        var records []*kgo.Record
        fetches.EachRecord(func(record *kgo.Record) {
            if record.Topic == c.Topic {
                records = append(records, record)
            }
        })

        for _, record := range records {
            outcome, err := c.handleRecordWithRecovery(ctx, record)
            if err != nil {
                // The durable UNKNOWN write did not complete, or an unrelated
                // safety boundary failed. Do not acknowledge this Kafka record.
                return err
            }
            if outcome == outcomeRetry {
                return errors.New("record requires redelivery after non-durable recovery failure")
            }
            if err := c.Client.CommitRecords(ctx, record); err != nil {
                return fmt.Errorf("commit Kafka reconciliation record: %w", err)
            }
        }
    }
}

type recordOutcome uint8

const (
    outcomeProcessed recordOutcome = iota
    outcomeRetry
)

func (c *Consumer) handleRecordWithRecovery(ctx context.Context, record *kgo.Record) (recordOutcome, error) {
    // HandleRecord must never post to TigerBeetle after an OPA failure. The
    // wrapper exists to classify OPA failures and ensure durable UNKNOWN state.
    err := c.HandleRecord(ctx, record)
    if err == nil {
        return outcomeProcessed, nil
    }
    return outcomeRetry, err
}

func (c *Consumer) evaluateOPAWithRetry(parent context.Context, input IntentPolicyInput) (IntentPolicyDecision, error) {
    var lastErr error

    for attempt := 1; attempt <= opaRetryAttempts; attempt++ {
        if err := parent.Err(); err != nil {
            return IntentPolicyDecision{}, err
        }

        evalCtx, cancel := context.WithTimeout(parent, opaEvaluationTimeout)
        decision, err := c.Policy.Evaluate(evalCtx, input)
        timedOut := errors.Is(err, context.DeadlineExceeded) || errors.Is(evalCtx.Err(), context.DeadlineExceeded)
        cancel()

        if err == nil {
            return decision, nil
        }
        lastErr = err
        if timedOut && c.Metrics != nil {
            c.Metrics.IncEvaluationTimeout()
        }
        if c.Metrics != nil {
            c.Metrics.IncEvaluationFailure(classifyOPAError(err, timedOut))
        }

        // Do not retry caller cancellation. Retrying a canceled Kafka delivery
        // only delays shutdown and cannot improve safety.
        if errors.Is(err, context.Canceled) || errors.Is(parent.Err(), context.Canceled) {
            return IntentPolicyDecision{}, err
        }
        if attempt < opaRetryAttempts {
            delay := opaRetryBaseDelay * time.Duration(1<<(attempt-1))
            timer := time.NewTimer(delay)
            select {
            case <-parent.Done():
                timer.Stop()
                return IntentPolicyDecision{}, parent.Err()
            case <-timer.C:
            }
        }
    }

    return IntentPolicyDecision{}, fmt.Errorf("OPA evaluation exhausted after %d attempts: %w", opaRetryAttempts, lastErr)
}

func classifyOPAError(err error, timeout bool) string {
    if timeout {
        return "timeout"
    }
    var netErr net.Error
    if errors.As(err, &netErr) && netErr.Timeout() {
        return "network_timeout"
    }
    if strings.Contains(strings.ToLower(err.Error()), "http 5") {
        return "upstream_5xx"
    }
    if strings.Contains(strings.ToLower(err.Error()), "decode") {
        return "malformed_response"
    }
    return "transport_or_contract"
}
```

The OPA portion inside `HandleRecord` should be replaced with this fail-closed block:

```go
policyInput := IntentPolicyInput{
    TenantID:            payload.TenantID,
    IntentID:            payload.IntentID,
    IdempotencyKey:      payload.IdempotencyKey,
    ReleaseSHA:          payload.ReleaseSHA,
    ReconciliationRunID: payload.ReconciliationRunID,
    Asset:               payload.Asset,
    AmountMinor:         payload.AmountMinor,
    ProviderFinal:       payload.ProviderFinal,
    BusinessEffect:      payload.BusinessEffect,
}

decision, err := c.evaluateOPAWithRetry(ctx, policyInput)
if err != nil {
    // The policy could not be authoritatively evaluated. Persist UNKNOWN before
    // any ledger call. If this write fails, return the error and do not commit
    // the Kafka offset.
    if markErr := c.Store.MarkUnknown(ctx, payload, "OPA policy evaluation unavailable", now); markErr != nil {
        if c.Metrics != nil {
            c.Metrics.IncUnknownPersistFailure()
        }
        return fmt.Errorf("OPA unavailable and UNKNOWN persistence failed: %w", markErr)
    }
    return c.Store.MarkEventProcessed(ctx, envelope.EventID, payload.TenantID, now)
}

if !decision.Allow {
    if c.Metrics != nil {
        c.Metrics.IncPolicyDeny(decision.Reason)
    }
    if err := c.Store.MarkUnknown(ctx, payload, "OPA denied intent: "+decision.Reason, now); err != nil {
        if c.Metrics != nil {
            c.Metrics.IncUnknownPersistFailure()
        }
        return fmt.Errorf("OPA denial could not be durably recorded: %w", err)
    }
    return c.Store.MarkEventProcessed(ctx, envelope.EventID, payload.TenantID, now)
}

// Only this branch may proceed to PostConfirmedTransfer.
```

## 4. Recovery state semantics

| Condition | TigerBeetle call | Durable state | Kafka offset |
|---|---:|---|---:|
| OPA returns `allow=true` | Allowed | Continue settlement flow | Commit after settlement/event processing |
| OPA returns `allow=false` | Never called | `UNKNOWN`, denial reason recorded | Commit only after UNKNOWN is durable |
| OPA timeout after bounded retries | Never called | `UNKNOWN`, unavailable reason recorded | Commit only after UNKNOWN is durable |
| OPA HTTP 5xx or connection error | Never called | `UNKNOWN`, unavailable reason recorded | Commit only after UNKNOWN is durable |
| OPA malformed JSON/missing result | Never called | `UNKNOWN`, unavailable reason recorded | Commit only after UNKNOWN is durable |
| PostgreSQL `MarkUnknown` fails | Never called | Not confirmed durable | Do not commit; return error for redelivery |
| TigerBeetle posting is ambiguous | Posting may have occurred | `UNKNOWN` | Do not commit unless the existing reconciliation path has durably captured the state |
| Process cancellation | No new work | Existing state unchanged | Do not acknowledge the in-flight record |

## 5. Required tests

At minimum, add tests for:

```text
OPA success → TigerBeetle called once
OPA explicit deny → TigerBeetle never called; UNKNOWN persisted; offset committed
OPA timeout → retries exactly three times; TigerBeetle never called
OPA HTTP 5xx → bounded retries; UNKNOWN persisted
OPA malformed response → UNKNOWN persisted; no ledger call
OPA missing result → UNKNOWN persisted; no ledger call
MarkUnknown failure → consumer returns error; no offset commit
parent context cancellation → no retry after cancellation
concurrent redelivery → durable inbox prevents duplicate settlement
```

The most important assertion is negative:

```go
if ledger.Calls() != 0 {
    t.Fatal("TigerBeetle must not be called when OPA is unavailable or denies")
}
```

## 6. Verification commands

```bash
helm lint deploy/helm/umoja-payment-engine \
  --set image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --set objectStorage.endpoint=https://s3-compatible.invalid \
  --set objectStorage.bucket=umoja-release-evidence \
  --set vault.address=https://vault.invalid \
  --set vault.objectStorageSecretPath=secret/data/umoja/object-storage

helm template umoja-payment-engine deploy/helm/umoja-payment-engine \
  --set image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --set objectStorage.endpoint=https://s3-compatible.invalid \
  --set objectStorage.bucket=umoja-release-evidence \
  --set vault.address=https://vault.invalid \
  --set vault.objectStorageSecretPath=secret/data/umoja/object-storage \
  > /tmp/umoja-payment-engine-rendered.yaml

kubectl apply --dry-run=client -f /tmp/umoja-payment-engine-rendered.yaml

opa fmt --fail infra/opa
opa check infra/opa
opa test infra/opa -v
```

For production, also require admission validation, the live sidecar readiness evidence, OPA decision metrics, and a negative test proving that OPA unavailability cannot reach TigerBeetle.

## Current repository gap

The existing Helm deployment already has OPA probes, but it does not currently define OPA-specific `resources` in `values.yaml`, and the current `Consume` method returns on a `HandleRecord` error rather than applying the bounded OPA retry and durable-UNKNOWN recovery behavior above. Those two gaps should be closed before treating the OPA enforcement path as production-complete.
