import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { Counter, Trend } from 'k6/metrics';

const paymentErrors = new Counter('synthetic_payment_errors_total');
const paymentLatency = new Trend('synthetic_payment_submission_latency_ms', true);

const baseURL = __ENV.PAYMENT_ENGINE_BASE_URL || 'http://127.0.0.1:18081';
const approvalSecret = __ENV.UMOJA_EXECUTION_APPROVAL_SECRET || '';
const allowSynthetic = __ENV.K6_ALLOW_SYNTHETIC_SUBMISSIONS === 'true';
const vuCount = Number(__ENV.K6_VUS || 16);
const duration = __ENV.K6_DURATION || '30s';

function assertLoopback(url) {
  const parsed = url.match(/^https?:\/\/([^/:]+)(?::\d+)?/);
  if (!parsed || !['127.0.0.1', 'localhost', '::1'].includes(parsed[1])) {
    throw new Error('This scenario is restricted to a loopback payment-engine endpoint');
  }
}

function paymentPayload() {
  const sequenceID = `k6-synthetic-${__VU}-${__ITER}-${Date.now()}`;
  return JSON.stringify({
    SequenceID: sequenceID,
    CustomerUID: `k6-customer-${__VU}`,
    CustomerType: 'retail',
    Reason: 'synthetic-load-test',
    Amount: 100,
    LocalAmount: 100,
    ChannelType: 'bank',
    Country: 'NG',
    Currency: 'NGN',
    Sender: {
      Name: 'Synthetic Sender', Country: 'NG', Phone: '+2348000000000',
      Address: 'Synthetic test address', DateOfBirth: '1990-01-01',
      Email: 'synthetic@example.invalid', IDNumber: 'SYNTHETIC', IDType: 'test'
    },
    Destination: {
      AccountNumber: '0000000000', AccountType: 'bank',
      NetworkID: 'synthetic-bank', AccountName: 'Synthetic Recipient'
    },
    ForceAccept: false
  });
}

function signedHeaders(body, path) {
  if (!approvalSecret) {
    throw new Error('UMOJA_EXECUTION_APPROVAL_SECRET is required');
  }
  const timestamp = new Date().toISOString();
  const digestB64 = crypto.sha256(body, 'base64');
  const signingInput = `${timestamp}POST${path}${digestB64}`;
  const signature = crypto.hmac('sha256', approvalSecret, signingInput, 'base64');
  return {
    'Content-Type': 'application/json',
    'X-Umoja-Execution-Timestamp': timestamp,
    'X-Umoja-Execution-Signature': signature
  };
}

export const options = {
  scenarios: {
    payment_and_metrics: {
      executor: 'constant-vus',
      vus: vuCount,
      duration,
      exec: 'paymentAndMetrics'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    synthetic_payment_errors_total: ['count<50'],
    synthetic_payment_submission_latency_ms: ['p(95)<1000']
  }
};

export function setup() {
  if (!allowSynthetic) {
    throw new Error('Set K6_ALLOW_SYNTHETIC_SUBMISSIONS=true to acknowledge loopback-only synthetic execution');
  }
  assertLoopback(baseURL);
  const health = http.get(`${baseURL}/healthz`);
  check(health, { 'payment engine health is reachable': (response) => response.status === 200 });
  return { paymentPath: '/v1/providers/yellowcard/sends' };
}

export function paymentAndMetrics(data) {
  const body = paymentPayload();
  const paymentStart = Date.now();
  const payment = http.post(`${baseURL}${data.paymentPath}`, body, {
    headers: signedHeaders(body, data.paymentPath),
    tags: { endpoint: 'payment_submission' }
  });
  paymentLatency.add(Date.now() - paymentStart);
  const accepted = check(payment, {
    'synthetic payment returns accepted or controlled failure': (response) => [202, 503].includes(response.status),
    'payment response is not a client validation error': (response) => response.status !== 400 && response.status !== 422
  });
  if (!accepted) paymentErrors.add(1);

  const metrics = http.get(`${baseURL}/metrics`, { tags: { endpoint: 'prometheus_metrics' } });
  check(metrics, {
    'Prometheus metrics endpoint returns 200': (response) => response.status === 200,
    'Prometheus content type is exposed': (response) => response.headers['Content-Type'] && response.headers['Content-Type'].includes('text/plain'),
    'signer metric family is present': (response) => response.body.includes('umoja_signer_retry_exhausted_total')
  });
  sleep(0.01);
}
