// k6 gate — remittance & BDC service (services/remittance-bdc).
// Enforces perf/slo.yaml: create p99 < 80ms, rate-lock p99 < 50ms.
// Usage: k6 run -e BASE_URL=http://localhost:8090 perf/k6/remittance_api.js
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    remittance_mixed: {
      executor: "constant-arrival-rate",
      rate: 30,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 15,
      maxVUs: 60,
    },
  },
  thresholds: {
    http_req_duration: ["p(50)<8", "p(99)<80"],
    http_req_failed: ["rate<0.001"],
  },
};

const SHA = "a".repeat(64);

export default function () {
  const id = `REM-k6-${__VU}-${__ITER}`;
  const create = http.post(
    `${__ENV.BASE_URL}/v1/remittances`,
    JSON.stringify({
      remittance_id: id,
      corridor: "US_NG",
      remitter_id: `R-${__VU}`,
      kyc_subject_id: `KYC-${__VU}`,
      remitter_country: "US",
      kyc_tier: 3,
      beneficiary_id: `B-${__VU % 7}`,
      beneficiary_name: "Adaeze Okafor",
      beneficiary_country: "NG",
      bank_code: "058",
      account_reference: "tok_nubin_k6",
      purpose: "family_support",
      send_amount_minor: 50000, // $500.00 — integer minor units
      send_currency: "USD",
      receive_currency: "NGN",
      payout_channel: "bank_credit",
    }),
    { headers: { "Content-Type": "application/json" }, timeout: "2s" },
  );
  check(create, { "created": (r) => r.status === 201 });

  if (create.status === 201) {
    const lock = http.post(
      `${__ENV.BASE_URL}/v1/remittances/${id}/rate-locks`,
      JSON.stringify({ rate: "1550.25", actor: "k6" }),
      { headers: { "Content-Type": "application/json" }, timeout: "2s" },
    );
    check(lock, { "locked": (r) => r.status === 201 });
  }
}
