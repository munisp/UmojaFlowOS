import { getPool, type Actor } from "./postgres";

/**
 * Live control pipeline persistence (migration 0039): provider send requests
 * and regulatory submission attempts. Previously orphaned schema — payment
 * provider send facts and regulator-channel submission attempts had no
 * writer, so their lifecycle could not be reconstructed from PostgreSQL.
 * Recording here never asserts settlement or filing acceptance by itself.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;

export async function recordProviderSendRequest(actor: Actor, input: {
  paymentOrderId: string;
  paymentLegId: string;
  integrationConnectionId: string;
  providerReference: string;
  providerStatus: string;
  requestSha256: string;
}) {
  if (!SHA256_RE.test(input.requestSha256)) throw new Error("request_sha256 must be 64 lowercase hex chars");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO provider_send_requests
       (payment_order_id, payment_leg_id, integration_connection_id, provider_reference, provider_status, request_sha256)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (payment_leg_id, provider_reference) DO NOTHING
     RETURNING id`,
    [input.paymentOrderId, input.paymentLegId, input.integrationConnectionId, input.providerReference, input.providerStatus, input.requestSha256],
  );
  return { id: rows[0]?.id ?? null };
}

export async function transitionProviderSendRequest(actor: Actor, input: {
  sendRequestId: string;
  finalityState: "webhook_confirmed" | "reconciliation_pending" | "reconciled" | "failed" | "discrepancy";
  providerFinalityReference?: string | null;
  reconciliationReference?: string | null;
}) {
  if (input.finalityState === "reconciled" && !input.reconciliationReference) {
    throw new Error("finality_state 'reconciled' requires reconciliation_reference");
  }
  const { rowCount } = await getPool().query(
    `UPDATE provider_send_requests
        SET finality_state=$2,
            provider_finality_reference=COALESCE($3, provider_finality_reference),
            reconciliation_reference=COALESCE($4, reconciliation_reference)
      WHERE id=$1 AND finality_state NOT IN ('reconciled','failed')`,
    [input.sendRequestId, input.finalityState, input.providerFinalityReference ?? null, input.reconciliationReference ?? null],
  );
  if (rowCount === 0) throw new Error("send request not found or already terminal");
}

export async function listProviderSendRequests(paymentOrderId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, payment_order_id AS "paymentOrderId", payment_leg_id AS "paymentLegId",
            integration_connection_id AS "integrationConnectionId", provider_reference AS "providerReference",
            provider_status AS "providerStatus", accepted_at AS "acceptedAt",
            finality_state AS "finalityState", provider_finality_reference AS "providerFinalityReference",
            reconciliation_reference AS "reconciliationReference"
       FROM provider_send_requests
      ${paymentOrderId ? "WHERE payment_order_id=$1" : ""}
      ORDER BY accepted_at DESC LIMIT 500`,
    paymentOrderId ? [paymentOrderId] : [],
  );
  return rows;
}

export async function recordRegulatorySubmissionAttempt(actor: Actor, input: {
  regulatoryReportId: string;
  integrationConnectionId: string;
  channelReference: string;
  requestSha256: string;
  attemptState: "prepared" | "submitted" | "accepted" | "rejected" | "unavailable";
  externalReference?: string | null;
  responseEvidenceSha256?: string | null;
}) {
  if (!SHA256_RE.test(input.requestSha256)) throw new Error("request_sha256 must be 64 lowercase hex chars");
  if (["submitted", "accepted", "rejected"].includes(input.attemptState) && !input.externalReference) {
    throw new Error(`attempt_state '${input.attemptState}' requires external_reference`);
  }
  if (input.responseEvidenceSha256 && !SHA256_RE.test(input.responseEvidenceSha256)) {
    throw new Error("response_evidence_sha256 must be 64 lowercase hex chars");
  }
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO regulatory_submission_attempts
       (regulatory_report_id, integration_connection_id, channel_reference, request_sha256,
        attempt_state, external_reference, submitted_at, response_evidence_sha256)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 IN ('submitted','accepted','rejected') THEN now() ELSE NULL END, $7)
     ON CONFLICT (regulatory_report_id, request_sha256) DO NOTHING
     RETURNING id`,
    [
      input.regulatoryReportId, input.integrationConnectionId, input.channelReference, input.requestSha256,
      input.attemptState, input.externalReference ?? null, input.responseEvidenceSha256 ?? null,
    ],
  );
  return { id: rows[0]?.id ?? null };
}

export async function listRegulatorySubmissionAttempts(regulatoryReportId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, regulatory_report_id AS "regulatoryReportId", integration_connection_id AS "integrationConnectionId",
            channel_reference AS "channelReference", attempt_state AS "attemptState",
            external_reference AS "externalReference", submitted_at AS "submittedAt", recorded_at AS "recordedAt"
       FROM regulatory_submission_attempts
      ${regulatoryReportId ? "WHERE regulatory_report_id=$1" : ""}
      ORDER BY recorded_at DESC LIMIT 500`,
    regulatoryReportId ? [regulatoryReportId] : [],
  );
  return rows;
}
