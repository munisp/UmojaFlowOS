// k6 CI gate — payment-engine authorize path.
// Enforces perf/slo.yaml: p99 < 50ms at 50 RPS sustained.
// Usage: k6 run -e BASE_URL=http://localhost:8080 perf/k6/payment_engine_smoke.js
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const authorizeLatency = new Trend("grpc_authorize_ms", true);

export const options = {
  scenarios: {
    authorize_gate: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    // fail-closed CI gates — a missed SLO fails the build
    http_req_duration: ["p(50)<5", "p(99)<50", "p(99.9)<120"],
    http_req_failed: ["rate<0.001"],
    grpc_authorize_ms: ["p(99)<50"],
  },
};

const HEADERS = { "Content-Type": "application/json" };

export default function () {
  const idem = `k6-${__VU}-${__ITER}`;
  const payload = JSON.stringify({
    intent_id: idem,
    direction: "onramp",
    asset: "USDC",
    fiat: "NGN",
    amount_minor: 1250000, // integer minor units only
    destination: "tok_nubin_k6",
  });
  const res = http.post(`${__ENV.BASE_URL}/v1/intents`, payload, {
    headers: { ...HEADERS, "Idempotency-Key": idem },
    timeout: "2s",
  });
  authorizeLatency.add(res.timings.duration);
  check(res, {
    "accepted or fail-closed": (r) => [200, 201, 422].includes(r.status),
    "never 5xx on hot path": (r) => r.status < 500,
  });
}
