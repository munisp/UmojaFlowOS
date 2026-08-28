import { isIP } from "node:net";
import { Pool } from "pg";
import type { OperatingRole } from "./operatingRoles";
import { createHash, randomUUID } from "node:crypto";
import { storageCreateUploadUrl, storageGetSignedUrl } from "./storage";

const localDevelopmentConfig = {
  host: "/var/run/postgresql",
  database: "umojaflowos_dev",
  user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
};

let pool: Pool | undefined;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

export function getPool() {
  if (!pool) {
    const commonOptions = {
      max: positiveInteger(process.env.POSTGRES_POOL_MAX, 10, "POSTGRES_POOL_MAX"),
      connectionTimeoutMillis: positiveInteger(process.env.POSTGRES_CONNECTION_TIMEOUT_MS, 5_000, "POSTGRES_CONNECTION_TIMEOUT_MS"),
      idleTimeoutMillis: positiveInteger(process.env.POSTGRES_IDLE_TIMEOUT_MS, 30_000, "POSTGRES_IDLE_TIMEOUT_MS"),
      statement_timeout: positiveInteger(process.env.POSTGRES_STATEMENT_TIMEOUT_MS, 30_000, "POSTGRES_STATEMENT_TIMEOUT_MS"),
      lock_timeout: positiveInteger(process.env.POSTGRES_LOCK_TIMEOUT_MS, 5_000, "POSTGRES_LOCK_TIMEOUT_MS"),
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    };
    pool = process.env.POSTGRES_DATABASE_URL
      ? new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL, ...commonOptions })
      : new Pool({ ...localDevelopmentConfig, ...commonOptions });
    pool.on("error", error => {
      console.error("postgres pool client error", error);
    });
  }
  return pool;
}

export async function getPostgresReadiness() {
  const client = await getPool().connect();
  try {
    const version = await client.query<{ version: string }>("SELECT version() AS version");
    const tableCount = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'");
    return {
      connected: true,
      database: client.database,
      tableCount: Number(tableCount.rows[0]?.count ?? 0),
      version: version.rows[0]?.version ?? "unknown",
    };
  } finally {
    client.release();
  }
}

export async function getPostgresDashboardSnapshot() {
  const client = await getPool().connect();
  try {
    const [counterpartyCounts, integrationCounts, paymentCounts, caseCounts, reportCounts, latestEvents] = await Promise.all([
      client.query<{ state: string; count: string }>("SELECT counterparty_type AS state, count(*)::text AS count FROM counterparties GROUP BY counterparty_type"),
      client.query<{ state: string; count: string }>("SELECT state::text AS state, count(*)::text AS count FROM integration_connections GROUP BY state"),
      client.query<{ state: string; count: string }>("SELECT status::text AS state, count(*)::text AS count FROM payment_orders GROUP BY status"),
      client.query<{ state: string; count: string }>("SELECT status::text AS state, count(*)::text AS count FROM compliance_cases GROUP BY status"),
      client.query<{ state: string; count: string }>("SELECT status::text AS state, count(*)::text AS count FROM regulatory_reports GROUP BY status"),
      client.query<{ id: string; actorSubject: string; actorRole: string; action: string; objectType: string; objectId: string | null; metadata: unknown; occurredAt: Date }>(
        `SELECT id, actor_subject AS "actorSubject", actor_role::text AS "actorRole", action, object_type AS "objectType", object_id AS "objectId", metadata, occurred_at AS "occurredAt"
           FROM activity_events ORDER BY occurred_at DESC, id DESC LIMIT 12`,
      ),
    ]);
    return { counterpartyCounts: counterpartyCounts.rows, integrationCounts: integrationCounts.rows, paymentCounts: paymentCounts.rows, caseCounts: caseCounts.rows, reportCounts: reportCounts.rows, latestEvents: latestEvents.rows };
  } finally { client.release(); }
}

const canonicalTables = [
  "activity_events", "alert_policies", "beneficiaries", "compliance_cases", "corridor_policies", "counterparties", "counterparty_authorizations", "counterparty_onboardings", "counterparty_onboarding_gate_decisions", "counterparty_evidence_items", "counterparty_financial_soundness_decisions", "bank_evidence_items", "counterparty_crypto_posture_decisions", "psp_evidence_items", "psp_gate_decisions", "stablecoin_issuer_evidence_items", "stablecoin_issuer_gate_decisions", "compliance_vendor_evidence_items", "compliance_vendor_gate_decisions", "operator_onboarding_records", "counterparty_risk_assessments", "customers", "customer_destination_counterparties", "customer_use_case_gate_decisions", "document_analysis_evidence", "document_analysis_jobs", "integration_connections", "kyc_documents", "kyc_document_upload_intents", "legal_entities", "liquidity_positions", "market_observations", "notification_deliveries", "payment_legs", "payment_orders", "policy_decisions", "rate_locks", "regulatory_deadlines", "regulatory_reports", "sar_str_filings", "scheduled_jobs", "treasury_buffer_policies", "treasury_rebalancing_recommendations", "treasury_stress_test_runs", "user_role_assignments", "verification_consents", "verification_reviewer_decisions",
] as const;

export async function getPostgresCutoverReadiness() {
  const client = await getPool().connect();
  try {
    const tables = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    const present = new Set(tables.rows.map(row => row.tablename));
    const missingTables = canonicalTables.filter(table => !present.has(table));
    return {
      ready: missingTables.length === 0,
      expectedTableCount: canonicalTables.length,
      presentTableCount: present.size,
      missingTables,
      activationBoundary: "PostgreSQL schema is locally validated; production cutover still requires a PostgreSQL deployment URI, a source snapshot, count-and-checksum reconciliation, and service health validation.",
    };
  } finally {
    client.release();
  }
}

export async function listPostgresCounterparties() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      legalName: string;
      counterpartyType: string;
      jurisdiction: string;
      createdAt: Date;
    }>("SELECT id, legal_name AS \"legalName\", counterparty_type AS \"counterpartyType\", jurisdiction, created_at AS \"createdAt\" FROM counterparties ORDER BY created_at DESC");
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresCustomers() {
  // documentCount/approvedDocumentCount are a real aggregate over kyc_documents,
  // not a stored or inferred status: they are what "evidence progress" derives
  // from on the enterprise-customer list, since customers.kyc_status itself is
  // never transitioned by any code path and would misrepresent progress.
  const { rows } = await getPool().query<{ id: string; legalName: string; registrationIdentifier: string; kycStatus: string; archetype: string | null; tier: string | null; documentCount: string; approvedDocumentCount: string; createdAt: Date }>(
    `SELECT customer.id, customer.legal_name AS "legalName", customer.registration_identifier AS "registrationIdentifier", customer.kyc_status AS "kycStatus", customer.archetype, customer.tier,
            count(document.id)::text AS "documentCount",
            count(document.id) FILTER (WHERE document.review_status = 'approved')::text AS "approvedDocumentCount",
            customer.created_at AS "createdAt"
       FROM customers customer
       LEFT JOIN kyc_documents document ON document.customer_id = customer.id
      GROUP BY customer.id
      ORDER BY customer.created_at DESC LIMIT 200`,
  );
  return rows;
}

export async function listPostgresBeneficiaries(customerId?: string) {
  const { rows } = await getPool().query<{ id: string; customerId: string; legalName: string; countryCode: string; bankOrWalletReference: string; screeningState: string; createdAt: Date }>(`SELECT id, customer_id AS "customerId", legal_name AS "legalName", country_code AS "countryCode", bank_or_wallet_reference AS "bankOrWalletReference", screening_state AS "screeningState", created_at AS "createdAt" FROM beneficiaries ${customerId ? "WHERE customer_id=$1" : ""} ORDER BY created_at DESC LIMIT 200`, customerId ? [customerId] : []);
  return rows;
}

export async function createPostgresCustomer(actor: Actor, input: { legalName: string; registrationIdentifier: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; legalName: string; registrationIdentifier: string; kycStatus: string; createdAt: Date }>(`INSERT INTO customers (legal_name, registration_identifier) VALUES ($1, $2) RETURNING id, legal_name AS "legalName", registration_identifier AS "registrationIdentifier", kyc_status AS "kycStatus", created_at AS "createdAt"`, [input.legalName, input.registrationIdentifier]);
    const customer = rows[0]; if (!customer) throw new Error("PostgreSQL customer insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [actor.openId, actor.role, "customer.created", "customer", customer.id, JSON.stringify({ legalName: customer.legalName, registrationIdentifier: customer.registrationIdentifier, source: "postgres-control-plane" })]);
    await client.query("COMMIT"); return customer;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresBeneficiary(actor: Actor, input: { customerId: string; legalName: string; countryCode: string; bankOrWalletReference: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const customer = await client.query<{ id: string }>("SELECT id FROM customers WHERE id=$1 FOR KEY SHARE", [input.customerId]);
    if (!customer.rows[0]) throw new Error("A canonical customer record is required before creating a beneficiary");
    const { rows } = await client.query<{ id: string; customerId: string; legalName: string; countryCode: string; bankOrWalletReference: string; screeningState: string; createdAt: Date }>(`INSERT INTO beneficiaries (customer_id, legal_name, country_code, bank_or_wallet_reference) VALUES ($1, $2, $3, $4) RETURNING id, customer_id AS "customerId", legal_name AS "legalName", country_code AS "countryCode", bank_or_wallet_reference AS "bankOrWalletReference", screening_state AS "screeningState", created_at AS "createdAt"`, [input.customerId, input.legalName, input.countryCode, input.bankOrWalletReference]);
    const beneficiary = rows[0]; if (!beneficiary) throw new Error("PostgreSQL beneficiary insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [actor.openId, actor.role, "beneficiary.created", "beneficiary", beneficiary.id, JSON.stringify({ customerId: beneficiary.customerId, countryCode: beneficiary.countryCode, source: "postgres-control-plane" })]);
    await client.query("COMMIT"); return beneficiary;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function recordPostgresBeneficiaryScreening(
  actor: Actor,
  input: {
    beneficiaryId: string;
    integrationConnectionId: string;
    correlationId: string;
    screeningState: "clear" | "potential_match" | "confirmed_match" | "source_unavailable";
    providerReference: string;
    sourceVersion: string;
    evidenceSha256: string;
    screenedAt: Date;
  },
) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const beneficiary = await client.query<{ id: string }>(
      "SELECT id FROM beneficiaries WHERE id=$1 FOR UPDATE",
      [input.beneficiaryId],
    );
    if (!beneficiary.rows[0]) throw new Error("A canonical beneficiary record is required before recording screening");

    const integration = await client.query<{ id: string }>(
      `SELECT id
         FROM integration_connections
        WHERE id=$1
          AND state='active'
          AND category IN ('sanctions', 'kyc_kyb')
        FOR KEY SHARE`,
      [input.integrationConnectionId],
    );
    if (!integration.rows[0]) {
      throw new Error("An active sanctions or KYC/KYB integration is required before recording beneficiary screening");
    }

    const latest = await client.query<{ screenedAt: Date }>(
      `SELECT screened_at AS "screenedAt"
         FROM aml_screening_checks
        WHERE beneficiary_id=$1
        ORDER BY screened_at DESC, recorded_at DESC
        LIMIT 1
        FOR UPDATE`,
      [input.beneficiaryId],
    );
    if (latest.rows[0] && input.screenedAt < latest.rows[0].screenedAt) {
      throw new Error("Stale beneficiary screening evidence cannot replace a newer screening decision");
    }

    const recorded = await client.query<{ id: string }>(
      `INSERT INTO aml_screening_checks
         (beneficiary_id, integration_connection_id, correlation_id, screening_scope, screening_state,
          provider_reference, source_version, evidence_sha256, screened_at)
       VALUES ($1,$2,$3,'beneficiary',$4::screening_state,$5,$6,$7,$8)
       RETURNING id`,
      [
        input.beneficiaryId,
        input.integrationConnectionId,
        input.correlationId,
        input.screeningState,
        input.providerReference,
        input.sourceVersion,
        input.evidenceSha256,
        input.screenedAt,
      ],
    );
    const check = recorded.rows[0];
    if (!check) throw new Error("Beneficiary screening evidence insert did not return a record");

    await client.query(
      "UPDATE beneficiaries SET screening_state=$1::screening_state WHERE id=$2",
      [input.screeningState, input.beneficiaryId],
    );
    await client.query(
      "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [
        actor.openId,
        actor.role,
        "beneficiary.screening_recorded",
        "beneficiary",
        input.beneficiaryId,
        JSON.stringify({
          screeningCheckId: check.id,
          integrationConnectionId: input.integrationConnectionId,
          correlationId: input.correlationId,
          screeningState: input.screeningState,
          providerReference: input.providerReference,
          sourceVersion: input.sourceVersion,
          evidenceSha256: input.evidenceSha256,
          screenedAt: input.screenedAt.toISOString(),
          source: "postgres-control-plane",
        }),
      ],
    );
    await client.query("COMMIT");
    return { id: check.id, beneficiaryId: input.beneficiaryId, screeningState: input.screeningState };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createPostgresCounterparty(
  actor: { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" | "provider_contact" | "cbn_liaison" },
  input: { legalName: string; counterpartyType: string; jurisdiction: string },
) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      legalName: string;
      counterpartyType: string;
      jurisdiction: string;
      createdAt: Date;
    }>("INSERT INTO counterparties (legal_name, counterparty_type, jurisdiction) VALUES ($1, $2, $3) RETURNING id, legal_name AS \"legalName\", counterparty_type AS \"counterpartyType\", jurisdiction, created_at AS \"createdAt\"", [input.legalName, input.counterpartyType, input.jurisdiction]);
    const counterparty = rows[0];
    if (!counterparty) throw new Error("PostgreSQL counterparty insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [actor.openId, actor.role, "counterparty.created", "counterparty", counterparty.id, JSON.stringify({ legalName: counterparty.legalName, counterpartyType: counterparty.counterpartyType, jurisdiction: counterparty.jurisdiction, source: "postgres-control-plane" })]);
    await client.query("COMMIT");
    return counterparty;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listPostgresCounterpartyAuthorizations() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      counterpartyId: string;
      legalName: string;
      regulator: string;
      licenceReference: string;
      scopeDescription: string;
      evidenceUri: string;
      validFrom: string;
      validTo: string | null;
      status: string;
      verifiedBy: string | null;
      verifiedAt: Date | null;
    }>(`SELECT cpa.id, cpa.counterparty_id AS "counterpartyId", counterparty.legal_name AS "legalName", cpa.regulator, cpa.licence_reference AS "licenceReference", cpa.scope_description AS "scopeDescription", cpa.evidence_uri AS "evidenceUri", cpa.valid_from::text AS "validFrom", cpa.valid_to::text AS "validTo", cpa.status, cpa.verified_by AS "verifiedBy", cpa.verified_at AS "verifiedAt"
       FROM counterparty_authorizations cpa
       JOIN counterparties counterparty ON counterparty.id = cpa.counterparty_id
       ORDER BY cpa.valid_to NULLS LAST, cpa.valid_from DESC`);
    return rows;
  } finally {
    client.release();
  }
}

export async function createPostgresCounterpartyAuthorization(
  actor: { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" | "provider_contact" | "cbn_liaison" },
  input: { counterpartyId: string; regulator: string; licenceReference: string; scopeDescription: string; evidenceUri: string; validFrom: Date; validTo?: Date; status: string },
) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      counterpartyId: string;
      regulator: string;
      licenceReference: string;
      status: string;
    }>("INSERT INTO counterparty_authorizations (counterparty_id, regulator, licence_reference, scope_description, evidence_uri, valid_from, valid_to, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, counterparty_id AS \"counterpartyId\", regulator, licence_reference AS \"licenceReference\", status", [input.counterpartyId, input.regulator, input.licenceReference, input.scopeDescription, input.evidenceUri, input.validFrom, input.validTo ?? null, input.status]);
    const authorization = rows[0];
    if (!authorization) throw new Error("PostgreSQL counterparty authorization insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [actor.openId, actor.role, "counterparty_authorization.created", "counterparty_authorization", authorization.id, JSON.stringify({ counterpartyId: authorization.counterpartyId, regulator: authorization.regulator, licenceReference: authorization.licenceReference, status: authorization.status, source: "postgres-control-plane" })]);
    await client.query("COMMIT");
    return authorization;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function transitionPostgresCounterpartyAuthorization(
  actor: { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" | "provider_contact" | "cbn_liaison" },
  input: { authorizationId: string; status: "pending_review" | "verified" | "expired" | "suspended" | "rejected" },
) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string }>("SELECT status::text AS status FROM counterparty_authorizations WHERE id=$1 FOR UPDATE", [input.authorizationId]);
    const existing = current.rows[0];
    if (!existing) throw new Error("PostgreSQL counterparty authorization was not found");
    const allowed: Record<string, string[]> = {
      pending_review: ["verified", "rejected", "suspended"],
      verified: ["expired", "suspended"],
      suspended: ["pending_review", "rejected"],
      expired: ["pending_review"],
      rejected: ["pending_review"],
    };
    if (!allowed[existing.status]?.includes(input.status)) throw new Error("invalid counterparty authorization lifecycle transition");
    const { rows } = await client.query<{ id: string; status: string }>(
      `UPDATE counterparty_authorizations
          SET status = $1::authorization_status,
              verified_by = CASE WHEN $1::authorization_status = 'verified' THEN $2 ELSE verified_by END,
              verified_at = CASE WHEN $1::authorization_status = 'verified' THEN now() ELSE verified_at END
        WHERE id = $3
        RETURNING id, status::text AS status`,
      [input.status, actor.openId, input.authorizationId],
    );
    const authorization = rows[0];
    if (!authorization) throw new Error("PostgreSQL counterparty authorization update did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [actor.openId, actor.role, "counterparty_authorization.transitioned", "counterparty_authorization", authorization.id, JSON.stringify({ from: existing.status, to: input.status, source: "postgres-control-plane" })]);
    await client.query("COMMIT");
    return authorization;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listPostgresKycDocuments() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      customerId: string;
      customerLegalName: string;
      documentType: string;
      storageKey: string;
      storageUrl: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: string;
      reviewStatus: string;
      reviewNote: string | null;
      reviewedBy: string | null;
      reviewedAt: Date | null;
      uploadedBy: string;
      uploadedAt: Date;
    }>(`SELECT document.id, document.customer_id AS "customerId", customer.legal_name AS "customerLegalName", document.document_type AS "documentType", document.storage_key AS "storageKey", document.storage_url AS "storageUrl", document.original_filename AS "originalFilename", document.mime_type AS "mimeType", document.size_bytes::text AS "sizeBytes", document.review_status AS "reviewStatus", document.review_note AS "reviewNote", document.reviewed_by AS "reviewedBy", document.reviewed_at AS "reviewedAt", document.uploaded_by AS "uploadedBy", document.uploaded_at AS "uploadedAt"
       FROM kyc_documents document
       JOIN customers customer ON customer.id = document.customer_id
       ORDER BY document.uploaded_at DESC`);
    return rows;
  } finally {
    client.release();
  }
}

export async function updatePostgresKycDocumentReview(actor: Actor, input: { documentId: string; reviewStatus: "under_review" | "approved" | "rejected" | "expired"; reviewNote: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ reviewStatus: string }>("SELECT review_status AS \"reviewStatus\" FROM kyc_documents WHERE id=$1 FOR UPDATE", [input.documentId]);
    const document = current.rows[0];
    if (!document) throw new Error("KYC document was not found");
    const allowed: Record<string, string[]> = { submitted: ["under_review", "expired"], under_review: ["approved", "rejected", "expired"], approved: ["expired"], rejected: [], expired: [] };
    if (!allowed[document.reviewStatus]?.includes(input.reviewStatus)) throw new Error("invalid KYC document review lifecycle transition");
    await client.query("UPDATE kyc_documents SET review_status=$1, review_note=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$4", [input.reviewStatus, input.reviewNote, actor.openId, input.documentId]);
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "kyc_document.review_transitioned", "kyc_document", input.documentId, JSON.stringify({ from: document.reviewStatus, to: input.reviewStatus, reviewNoteLength: input.reviewNote.trim().length, documentBytesPersisted: false })]);
    await client.query("COMMIT");
    return { id: input.documentId, reviewStatus: input.reviewStatus };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresKycDocumentUploadIntent(actor: Actor, input: { customerId: string; documentType: "registration_certificate" | "identity_document" | "proof_of_address" | "beneficial_ownership" | "source_of_funds" | "other"; originalFilename: string; mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/tiff"; sizeBytes: number; contentSha256: string }) {
  const customer = await getPool().query<{ id: string }>("SELECT id FROM customers WHERE id=$1", [input.customerId]);
  if (!customer.rows[0]) throw new Error("KYC upload requires an existing canonical customer record");
  const safeFilename = input.originalFilename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "document";
  const { key, uploadUrl } = await storageCreateUploadUrl(`kyc-document-intake/${input.customerId}/${safeFilename}`, input.mimeType);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>("INSERT INTO kyc_document_upload_intents (customer_id, document_type, original_filename, mime_type, size_bytes, content_sha256, storage_key, uploaded_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", [input.customerId, input.documentType, input.originalFilename, input.mimeType, input.sizeBytes, input.contentSha256, key, actor.openId, expiresAt]);
    const intent = rows[0];
    if (!intent) throw new Error("KYC document upload intent insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "kyc_document.upload_intent_created", "kyc_document_upload_intent", intent.id, JSON.stringify({ customerId: input.customerId, documentType: input.documentType, mimeType: input.mimeType, sizeBytes: input.sizeBytes, contentSha256: input.contentSha256, storageKey: key, expiresAt: expiresAt.toISOString(), documentBytesPersisted: false })]);
    await client.query("COMMIT");
    return { id: intent.id, storageKey: key, uploadUrl, expiresAt };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function finalizePostgresKycDocumentUpload(actor: Actor, uploadIntentId: string) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const intentQuery = await client.query<{ customerId: string; documentType: string; originalFilename: string; mimeType: string; sizeBytes: string; contentSha256: string; storageKey: string; uploadedBy: string; expiresAt: Date; finalizedAt: Date | null }>("SELECT customer_id AS \"customerId\", document_type AS \"documentType\", original_filename AS \"originalFilename\", mime_type AS \"mimeType\", size_bytes::text AS \"sizeBytes\", content_sha256 AS \"contentSha256\", storage_key AS \"storageKey\", uploaded_by AS \"uploadedBy\", expires_at AS \"expiresAt\", finalized_at AS \"finalizedAt\" FROM kyc_document_upload_intents WHERE id=$1 FOR UPDATE", [uploadIntentId]);
    const intent = intentQuery.rows[0];
    if (!intent) throw new Error("KYC upload intent was not found");
    if (intent.uploadedBy !== actor.openId) throw new Error("only the originating compliance operator may finalize this KYC upload");
    if (intent.finalizedAt) throw new Error("KYC upload intent has already been finalized");
    if (intent.expiresAt <= new Date()) throw new Error("KYC upload intent expired before verification");
    const signedUrl = await storageGetSignedUrl(intent.storageKey);
    const objectResponse = await fetch(signedUrl);
    if (!objectResponse.ok) throw new Error("uploaded KYC document is unavailable from secured storage");
    const contentType = objectResponse.headers.get("content-type")?.split(";")[0];
    const bytes = Buffer.from(await objectResponse.arrayBuffer());
    if (contentType !== intent.mimeType || bytes.byteLength !== Number(intent.sizeBytes)) throw new Error("uploaded KYC document metadata does not match its declared secure-upload intent");
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== intent.contentSha256) throw new Error("uploaded KYC document checksum does not match its declared secure-upload intent");
    const { rows } = await client.query<{ id: string; reviewStatus: string }>("INSERT INTO kyc_documents (customer_id, document_type, storage_key, storage_url, original_filename, mime_type, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, review_status AS \"reviewStatus\"", [intent.customerId, intent.documentType, intent.storageKey, `/storage/${intent.storageKey}`, intent.originalFilename, intent.mimeType, Number(intent.sizeBytes), actor.openId]);
    const document = rows[0];
    if (!document) throw new Error("KYC document metadata insert did not return a record");
    await client.query("UPDATE kyc_document_upload_intents SET finalized_at=now() WHERE id=$1", [uploadIntentId]);
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "kyc_document.upload_verified_and_recorded", "kyc_document", document.id, JSON.stringify({ uploadIntentId, customerId: intent.customerId, documentType: intent.documentType, storageKey: intent.storageKey, sizeBytes: Number(intent.sizeBytes), contentSha256: intent.contentSha256, documentBytesPersisted: false })]);
    await client.query("COMMIT");
    return document;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listPostgresSarStrFilings() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      complianceCaseId: string;
      corridor: string;
      filingType: string;
      filingAuthority: string;
      sourceReference: string;
      status: string;
      submissionReference: string | null;
      createdBy: string;
      createdAt: Date;
      updatedAt: Date;
    }>("SELECT id, compliance_case_id AS \"complianceCaseId\", corridor, filing_type AS \"filingType\", filing_authority AS \"filingAuthority\", source_reference AS \"sourceReference\", status, submission_reference AS \"submissionReference\", created_by AS \"createdBy\", created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM sar_str_filings ORDER BY created_at DESC");
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresComplianceCases() {
  const { rows } = await getPool().query<{ id: string; caseType: string; status: string; severity: string; sourceReference: string; openedAt: Date }>("SELECT id, case_type AS \"caseType\", status, severity, source_reference AS \"sourceReference\", opened_at AS \"openedAt\" FROM compliance_cases ORDER BY opened_at DESC LIMIT 200");
  return rows;
}

export async function createPostgresComplianceCase(actor: Actor, input: { caseType: "kyc" | "sanctions" | "transaction_monitoring" | "travel_rule" | "counterparty" | "sar_str"; severity: "low" | "medium" | "high" | "critical"; sourceReference: string; decisionReason?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; status: string }>("INSERT INTO compliance_cases (case_type, severity, source_reference, decision_reason) VALUES ($1,$2,$3,$4) RETURNING id, status", [input.caseType, input.severity, input.sourceReference, input.decisionReason ?? null]);
    const complianceCase = rows[0];
    if (!complianceCase) throw new Error("PostgreSQL compliance case insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "compliance_case.opened", "compliance_case", complianceCase.id, JSON.stringify({ caseType: input.caseType, severity: input.severity, sourceReference: input.sourceReference, hasDecisionReason: Boolean(input.decisionReason?.trim()) })]);
    await client.query("COMMIT");
    return complianceCase;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresSarStrFiling(actor: Actor, input: { complianceCaseId: string; corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; filingType: "sar" | "str"; filingAuthority: string; sourceReference: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const caseResult = await client.query<{ id: string }>("SELECT id FROM compliance_cases WHERE id=$1 FOR UPDATE", [input.complianceCaseId]);
    if (!caseResult.rows[0]) throw new Error("SAR/STR filing requires an existing compliance case");
    const { rows } = await client.query<{ id: string; status: string }>("INSERT INTO sar_str_filings (compliance_case_id, corridor, filing_type, filing_authority, source_reference, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status", [input.complianceCaseId, input.corridor, input.filingType, input.filingAuthority, input.sourceReference, actor.openId]);
    const filing = rows[0];
    if (!filing) throw new Error("PostgreSQL SAR/STR filing insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "sar_str_filing.draft_created", "sar_str_filing", filing.id, JSON.stringify({ complianceCaseId: input.complianceCaseId, corridor: input.corridor, filingType: input.filingType, filingAuthority: input.filingAuthority, sourceReference: input.sourceReference })]);
    await client.query("COMMIT");
    return filing;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function transitionPostgresSarStrFiling(actor: Actor, input: { filingId: string; status: "under_review" | "approved_for_submission" | "pending_submission" | "submitted" | "submission_unavailable" | "rejected"; submissionReference?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string; submissionReference: string | null }>("SELECT status, submission_reference AS \"submissionReference\" FROM sar_str_filings WHERE id=$1 FOR UPDATE", [input.filingId]);
    const filing = current.rows[0];
    if (!filing) throw new Error("SAR/STR filing was not found");
    const allowed: Record<string, string[]> = { draft: ["under_review"], under_review: ["approved_for_submission", "rejected"], approved_for_submission: ["pending_submission"], pending_submission: ["submitted", "submission_unavailable"], submission_unavailable: ["pending_submission"], rejected: [] };
    if (!allowed[filing.status]?.includes(input.status)) throw new Error("invalid SAR/STR workflow transition");
    const submissionReference = input.submissionReference ?? filing.submissionReference;
    if (input.status === "submitted" && !submissionReference?.trim()) throw new Error("verified submission reference is required before submitted status");
    await client.query("UPDATE sar_str_filings SET status=$1, submission_reference=$2, updated_at=now() WHERE id=$3", [input.status, submissionReference ?? null, input.filingId]);
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "sar_str_filing.transitioned", "sar_str_filing", input.filingId, JSON.stringify({ from: filing.status, to: input.status, hasSubmissionReference: Boolean(submissionReference?.trim()), providerSubmissionActivated: false })]);
    await client.query("COMMIT");
    return { id: input.filingId, status: input.status };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listPostgresRegulatoryDeadlines() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      regulator: string;
      corridor: string;
      title: string;
      dueAt: Date;
      sourceReference: string;
      status: string;
      lastRemindedAt: Date | null;
      createdBy: string;
      createdAt: Date;
    }>("SELECT id, regulator, corridor, title, due_at AS \"dueAt\", source_reference AS \"sourceReference\", status, last_reminded_at AS \"lastRemindedAt\", created_by AS \"createdBy\", created_at AS \"createdAt\" FROM regulatory_deadlines ORDER BY due_at ASC");
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresNotificationDeliveries() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      alertPolicyId: string | null;
      alertType: string;
      deliveryState: string;
      destination: string;
      correlationId: string;
      payloadHash: string;
      createdAt: Date;
    }>("SELECT id, alert_policy_id AS \"alertPolicyId\", alert_type AS \"alertType\", delivery_state AS \"deliveryState\", destination, correlation_id AS \"correlationId\", payload_hash AS \"payloadHash\", created_at AS \"createdAt\" FROM notification_deliveries ORDER BY created_at DESC");
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresLiquidityPositions() {
  const { rows } = await getPool().query<{ id: string; corridor: string; currency: string; accountKind: string; accountReference: string; availableAmount: string; reservedAmount: string; sourceReference: string; reconciledAt: Date; recordedBy: string; createdAt: Date }>(
    `SELECT id, corridor, currency, account_kind AS "accountKind", account_reference AS "accountReference", available_amount::text AS "availableAmount", reserved_amount::text AS "reservedAmount", source_reference AS "sourceReference", reconciled_at AS "reconciledAt", recorded_by AS "recordedBy", created_at AS "createdAt" FROM liquidity_positions ORDER BY reconciled_at DESC, created_at DESC LIMIT 200`,
  );
  return rows;
}

export async function recordPostgresLiquidityPosition(actor: TreasuryActor, input: { corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; currency: "NGN" | "KES" | "ZAR" | "USD" | "USDC" | "USDT"; accountKind: "liquidity_pool" | "nostro" | "vostro" | "prefunding" | "custody_wallet"; accountReference: string; availableAmount: string; reservedAmount: string; sourceReference: string; reconciledAt: Date }) {
  const available = Number(input.availableAmount), reserved = Number(input.reservedAmount);
  if (!Number.isFinite(available) || !Number.isFinite(reserved) || available < 0 || reserved < 0) throw new Error("Liquidity evidence must contain non-negative finite source-backed amounts");
  if (input.reconciledAt > new Date()) throw new Error("Liquidity reconciliation timestamp cannot be in the future");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(`INSERT INTO liquidity_positions (corridor,currency,account_kind,account_reference,available_amount,reserved_amount,source_reference,reconciled_at,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [input.corridor,input.currency,input.accountKind,input.accountReference,available,reserved,input.sourceReference,input.reconciledAt,actor.openId]);
    const id = rows[0]?.id; if (!id) throw new Error("PostgreSQL liquidity position insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId,actor.role,"liquidity_position.recorded","liquidity_position",id,JSON.stringify({ corridor: input.corridor, currency: input.currency, accountKind: input.accountKind, accountReference: input.accountReference, sourceReference: input.sourceReference, reconciledAt: input.reconciledAt.toISOString(), transferInitiated: false })]);
    await client.query("COMMIT"); return { id };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listPostgresMarketObservations() {
  const { rows } = await getPool().query<{ id: string; integrationConnectionId: string; baseAsset: string; quoteAsset: string; rate: string; observedAt: Date; sourceReference: string }>(`SELECT id, integration_connection_id AS "integrationConnectionId", base_asset AS "baseAsset", quote_asset AS "quoteAsset", rate::text AS rate, observed_at AS "observedAt", source_reference AS "sourceReference" FROM market_observations ORDER BY observed_at DESC LIMIT 200`);
  return rows;
}

export async function recordPostgresMarketObservation(actor: TreasuryActor, input: { integrationConnectionId: string; baseAsset: "NGN" | "KES" | "ZAR" | "USD" | "USDC" | "USDT"; quoteAsset: "NGN" | "KES" | "ZAR" | "USD" | "USDC" | "USDT"; rate: string; observedAt: Date; sourceReference: string }) {
  const rate = Number(input.rate); if (!Number.isFinite(rate) || rate <= 0 || input.baseAsset === input.quoteAsset) throw new Error("Market observation requires a positive source-backed cross-asset rate");
  const client = await getPool().connect(); try { await client.query("BEGIN"); const integration = await client.query<{ category: string; state: string }>("SELECT category,state FROM integration_connections WHERE id=$1 FOR KEY SHARE", [input.integrationConnectionId]); const source = integration.rows[0]; if (!source || !["fx_rate","stablecoin_market_data"].includes(source.category) || source.state !== "active") throw new Error("An active canonical FX or stablecoin market-data integration is required"); const row = await client.query<{ id: string }>(`INSERT INTO market_observations (integration_connection_id,base_asset,quote_asset,rate,observed_at,source_reference) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [input.integrationConnectionId,input.baseAsset,input.quoteAsset,rate,input.observedAt,input.sourceReference]); const id = row.rows[0]?.id; if (!id) throw new Error("PostgreSQL market observation insert did not return a record"); await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId,actor.role,"market_observation.recorded","market_observation",id,JSON.stringify({ integrationConnectionId: input.integrationConnectionId, baseAsset: input.baseAsset, quoteAsset: input.quoteAsset, sourceReference: input.sourceReference, providerExecutionInitiated: false })]); await client.query("COMMIT"); return { id }; } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

type TreasuryActor = { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" | "provider_contact" | "cbn_liaison" };

export async function createPostgresTreasuryRecommendation(actor: TreasuryActor, input: { bufferPolicyId: string; reconciledAvailableBalance: string; reconciledAt: Date; balanceSourceReference: string; verifiedNearTermFundingGap: string; fundingGapSourceReference: string; expiresAt: Date }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const policy = await client.query<{ corridor: string; currency: string; daily: string; minimumPct: string; targetPct: string; capPct: string; effectiveFrom: Date; effectiveTo: Date | null }>(`SELECT corridor, currency, approved_daily_outflow::text AS daily, minimum_buffer_pct::text AS "minimumPct", target_buffer_pct::text AS "targetPct", max_recommendation_pct_of_target::text AS "capPct", effective_from AS "effectiveFrom", effective_to AS "effectiveTo" FROM treasury_buffer_policies WHERE id=$1 FOR UPDATE`, [input.bufferPolicyId]);
    const p = policy.rows[0], now = new Date();
    if (!p || p.effectiveFrom > now || (p.effectiveTo && p.effectiveTo <= now)) throw new Error("Active approved treasury buffer policy is required");
    if (input.reconciledAt > now || now.getTime() - input.reconciledAt.getTime() > 86_400_000) throw new Error("Reconciled balance is unavailable or stale; recommendation generation fails closed");
    if (input.expiresAt <= now) throw new Error("Recommendation expiry must be in the future");
    const available = Number(input.reconciledAvailableBalance), gap = Number(input.verifiedNearTermFundingGap), daily = Number(p.daily), minimum = daily * Number(p.minimumPct), target = daily * Number(p.targetPct), cap = target * Number(p.capPct);
    if (![available, gap, daily, minimum, target, cap].every(Number.isFinite) || available < 0 || gap < 0) throw new Error("Invalid reconciled evidence; recommendation generation fails closed");
    const recommendation = Math.max(0, Math.min(target - available, cap, gap));
    const evidence = { bufferPolicyId: input.bufferPolicyId, approvedDailyOutflow: p.daily, minimumBufferPct: p.minimumPct, targetBufferPct: p.targetPct, maxRecommendationPctOfTarget: p.capPct, balanceSourceReference: input.balanceSourceReference, fundingGapSourceReference: input.fundingGapSourceReference, formula: "min(target - available, target * cap_pct, verified_funding_gap)" };
    const row = await client.query<{ id: string }>(`INSERT INTO treasury_rebalancing_recommendations (buffer_policy_id,corridor,currency,reconciled_available_balance,reconciled_at,balance_source_reference,verified_near_term_funding_gap,funding_gap_source_reference,minimum_buffer_amount,target_buffer_amount,computed_recommendation_amount,calculation_evidence,proposed_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) RETURNING id`, [input.bufferPolicyId,p.corridor,p.currency,available,input.reconciledAt,input.balanceSourceReference,gap,input.fundingGapSourceReference,minimum,target,recommendation,JSON.stringify(evidence),actor.openId,input.expiresAt]);
    const id = row.rows[0]?.id; if (!id) throw new Error("Treasury recommendation insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId,actor.role,"treasury_recommendation.proposed","treasury_rebalancing_recommendation",id,JSON.stringify({ ...evidence, recommendationAmount: recommendation, executionInitiated: false })]);
    await client.query("COMMIT"); return { id, minimumBufferAmount: String(minimum), targetBufferAmount: String(target), recommendationAmount: String(recommendation), status: "proposed" as const };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function decidePostgresTreasuryRecommendation(actor: TreasuryActor, input: { recommendationId: string; decision: "approved" | "rejected"; decisionReason: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ proposedBy: string; expiresAt: Date }>(`SELECT proposed_by AS "proposedBy", expires_at AS "expiresAt" FROM treasury_rebalancing_recommendations WHERE id=$1 AND status='proposed' FOR UPDATE`, [input.recommendationId]);
    const record = row.rows[0]; if (!record) throw new Error("Only proposed recommendations may be decided"); if (record.proposedBy === actor.openId) throw new Error("Independent approval is required; proposer cannot decide recommendation"); if (record.expiresAt <= new Date()) throw new Error("Expired recommendation cannot be decided");
    await client.query(`UPDATE treasury_rebalancing_recommendations SET status=$1,decided_by=$2,decided_at=now(),decision_reason=$3 WHERE id=$4`, [input.decision,actor.openId,input.decisionReason,input.recommendationId]);
    await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId,actor.role,`treasury_recommendation.${input.decision}`,"treasury_rebalancing_recommendation",input.recommendationId,JSON.stringify({ decisionReason: input.decisionReason, executionInitiated: false })]);
    await client.query("COMMIT"); return { id: input.recommendationId, status: input.decision };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function transitionPostgresRegulatoryReport(actor: TreasuryActor, input: { reportId: string; status: "under_review" | "approved" | "pending_submission" | "submitted" | "rejected"; statusReason: string; artifactUri?: string; evidenceManifest?: unknown; submissionReference?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string; artifactUri: string | null; evidenceManifest: unknown; createdAt: Date }>(`SELECT status, artifact_uri AS "artifactUri", evidence_manifest AS "evidenceManifest", created_at AS "createdAt" FROM regulatory_reports WHERE id=$1 FOR UPDATE`, [input.reportId]);
    const report = current.rows[0]; if (!report) throw new Error("Regulatory report was not found");
    const artifactUri = input.artifactUri ?? report.artifactUri, evidenceManifest = input.evidenceManifest ?? report.evidenceManifest;
    if (["under_review", "approved", "pending_submission", "submitted"].includes(input.status) && (!artifactUri || !evidenceManifest)) throw new Error("Artifact URI and evidence manifest are required for the requested reporting workflow state");
    if (input.status === "submitted" && !input.submissionReference) throw new Error("Verified submission reference is required before a report can be marked submitted");
    if (input.status === "approved" && actor.role !== "compliance_officer") throw new Error("Only a compliance officer may approve a regulatory report");
    await client.query(`UPDATE regulatory_reports SET status=$1::report_status,artifact_uri=$2,evidence_manifest=$3,submission_reference=COALESCE($4,submission_reference),status_reason=$5,reviewed_by=CASE WHEN $1::text='under_review' THEN $6 ELSE reviewed_by END,reviewed_at=CASE WHEN $1::text='under_review' THEN now() ELSE reviewed_at END,approved_by=CASE WHEN $1::text='approved' THEN $6 ELSE approved_by END,approved_at=CASE WHEN $1::text='approved' THEN now() ELSE approved_at END WHERE id=$7`, [input.status,artifactUri,JSON.stringify(evidenceManifest),input.submissionReference ?? null,input.statusReason,actor.openId,input.reportId]);
    await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId,actor.role,`regulatory_report.${input.status}`,"regulatory_report",input.reportId,JSON.stringify({ statusReason: input.statusReason, hasArtifact: Boolean(artifactUri), hasEvidenceManifest: Boolean(evidenceManifest), submissionReferencePresent: Boolean(input.submissionReference), providerSubmissionInitiated: false })]);
    await client.query("COMMIT"); return { id: input.reportId, status: input.status };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listPostgresRegulatoryReports() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ id: string; regulator: string; corridor: string; reportType: string; periodEnd: Date; status: string; artifactUri: string | null; submissionReference: string | null }>(
      `SELECT id, regulator, corridor, report_type AS "reportType", period_end AS "periodEnd", status, artifact_uri AS "artifactUri", submission_reference AS "submissionReference"
       FROM regulatory_reports ORDER BY period_end DESC LIMIT 100`,
    );
    return rows;
  } finally { client.release(); }
}

export async function createPostgresRegulatoryReport(actor: TreasuryActor, input: { regulator: "CBN" | "CBK" | "SARB"; corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; reportType: string; periodStart: Date; periodEnd: Date; legalEntityId: string }) {
  if (input.periodEnd < input.periodStart) throw new Error("Report period end must not precede period start");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const entity = await client.query("SELECT id FROM legal_entities WHERE id=$1", [input.legalEntityId]); if (!entity.rows[0]) throw new Error("Legal entity was not found");
    const { rows } = await client.query<{ id: string }>(`INSERT INTO regulatory_reports (regulator,corridor,report_type,period_start,period_end,legal_entity_id,status) VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING id`, [input.regulator, input.corridor, input.reportType, input.periodStart, input.periodEnd, input.legalEntityId]);
    const id = rows[0]?.id; if (!id) throw new Error("PostgreSQL report draft insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "regulatory_report.drafted", "regulatory_report", id, JSON.stringify({ regulator: input.regulator, corridor: input.corridor, reportType: input.reportType })]);
    await client.query("COMMIT"); return { id, status: "draft" as const };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresCounterpartyRiskAssessment(actor: TreasuryActor, input: { counterpartyId: string; riskLevel: "low" | "medium" | "high" | "critical"; riskScore: string; riskFactors: unknown; evidenceManifest: unknown; assessedAt: Date; nextReviewAt: Date }) {
  if (input.nextReviewAt <= input.assessedAt) throw new Error("Counterparty next review must follow the assessment timestamp");
  const score = Number(input.riskScore); if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("Counterparty risk score must be between 0 and 100");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query("SELECT id FROM counterparties WHERE id=$1", [input.counterpartyId]); if (!counterparty.rows[0]) throw new Error("Counterparty was not found");
    const row = await client.query<{ id: string }>(`INSERT INTO counterparty_risk_assessments (counterparty_id,risk_level,risk_score,risk_factors,evidence_manifest,assessed_at,next_review_at,assessed_by) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) RETURNING id`, [input.counterpartyId,input.riskLevel,score,JSON.stringify(input.riskFactors),JSON.stringify(input.evidenceManifest),input.assessedAt,input.nextReviewAt,actor.openId]);
    const id = row.rows[0]?.id; if (!id) throw new Error("Counterparty risk assessment insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId,actor.role,"counterparty_risk_assessment.created","counterparty_risk_assessment",id,JSON.stringify({ counterpartyId: input.counterpartyId,riskLevel: input.riskLevel,riskScore: score,nextReviewAt: input.nextReviewAt.toISOString() })]);
    await client.query("COMMIT"); return { id, reviewStatus: "current" as const };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function escalatePostgresCounterpartyRiskAssessment(actor: TreasuryActor, input: { assessmentId: string; reason: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ id: string }>(`UPDATE counterparty_risk_assessments SET review_status='escalated',escalation_reason=$1,escalated_by=$2,escalated_at=now() WHERE id=$3 AND review_status <> 'escalated' RETURNING id`, [input.reason, actor.openId, input.assessmentId]);
    const id = row.rows[0]?.id; if (!id) throw new Error("Counterparty risk assessment was not found or is already escalated");
    await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "counterparty_risk_assessment.escalated", "counterparty_risk_assessment", id, JSON.stringify({ reason: input.reason })]);
    await client.query("COMMIT"); return { id, reviewStatus: "escalated" as const };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function evaluatePostgresCounterpartyRiskReviews(actor: TreasuryActor, now = new Date()) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; reviewStatus: "due" | "overdue" }>(
      `UPDATE counterparty_risk_assessments
       SET review_status = CASE WHEN next_review_at < $1 THEN 'overdue'::counterparty_review_status ELSE 'due'::counterparty_review_status END
       WHERE review_status = 'current' AND next_review_at <= $1
       RETURNING id, review_status AS "reviewStatus"`,
      [now],
    );
    for (const row of rows) {
      await client.query("INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, `counterparty_risk_assessment.${row.reviewStatus}`, "counterparty_risk_assessment", row.id, JSON.stringify({ evaluatedAt: now.toISOString() })]);
    }
    await client.query("COMMIT"); return { evaluated: rows.length, due: rows.filter(row => row.reviewStatus === "due").length, overdue: rows.filter(row => row.reviewStatus === "overdue").length };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function getPostgresScheduledJobByTaskUid(taskUid: string) {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ purpose: string; enabled: boolean }>("SELECT purpose, enabled FROM scheduled_jobs WHERE schedule_cron_task_uid=$1", [taskUid]);
    return rows[0] ?? null;
  } finally { client.release(); }
}

export async function markPostgresScheduledJobExecuted(taskUid: string) {
  const client = await getPool().connect();
  try { await client.query("UPDATE scheduled_jobs SET last_executed_at=now() WHERE schedule_cron_task_uid=$1", [taskUid]); } finally { client.release(); }
}

export async function listPostgresCounterpartyRiskAssessments() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ id: string; counterpartyId: string; riskLevel: string; riskScore: string; reviewStatus: string; assessedAt: Date; nextReviewAt: Date; escalatedAt: Date | null }>(
      `SELECT id, counterparty_id AS "counterpartyId", risk_level AS "riskLevel", risk_score::text AS "riskScore", review_status AS "reviewStatus", assessed_at AS "assessedAt", next_review_at AS "nextReviewAt", escalated_at AS "escalatedAt"
       FROM counterparty_risk_assessments ORDER BY next_review_at ASC, assessed_at DESC`,
    );
    return rows;
  } finally { client.release(); }
}

export async function listPostgresDocumentAnalysisJobs() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      consentId: string;
      kycDocumentId: string | null;
      caseKind: string;
      documentClass: string;
      sourceSha256: string;
      sourceUri: string;
      mimeType: string;
      state: string;
      selectedModelTag: string | null;
      selectedModelDigest: string | null;
      selectedModelRole: string | null;
      submittedBy: string;
      submittedAt: Date;
      completedAt: Date | null;
    }>("SELECT id, consent_id AS \"consentId\", kyc_document_id AS \"kycDocumentId\", case_kind AS \"caseKind\", document_class AS \"documentClass\", source_sha256 AS \"sourceSha256\", source_uri AS \"sourceUri\", mime_type AS \"mimeType\", state, selected_model_tag AS \"selectedModelTag\", selected_model_digest AS \"selectedModelDigest\", selected_model_role AS \"selectedModelRole\", submitted_by AS \"submittedBy\", submitted_at AS \"submittedAt\", completed_at AS \"completedAt\" FROM document_analysis_jobs ORDER BY submitted_at DESC");
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresDocumentAnalysisEvidence() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      analysisJobId: string;
      caseKind: string;
      documentClass: string;
      kind: string;
      disposition: string;
      engineName: string;
      engineVersion: string;
      modelTag: string | null;
      modelDigest: string | null;
      promptPolicyVersion: string | null;
      evidenceSha256: string | null;
      signals: unknown[];
      limitations: unknown[];
      createdAt: Date;
    }>(`SELECT evidence.id, evidence.analysis_job_id AS "analysisJobId", job.case_kind AS "caseKind", job.document_class AS "documentClass", evidence.kind, evidence.disposition, evidence.engine_name AS "engineName", evidence.engine_version AS "engineVersion", evidence.model_tag AS "modelTag", evidence.model_digest AS "modelDigest", evidence.prompt_policy_version AS "promptPolicyVersion", evidence.evidence_sha256 AS "evidenceSha256", evidence.signals, evidence.limitations, evidence.created_at AS "createdAt"
        FROM document_analysis_evidence evidence
        JOIN document_analysis_jobs job ON job.id = evidence.analysis_job_id
        ORDER BY evidence.created_at DESC`);
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresReviewerDecisions() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      analysisJobId: string;
      caseKind: string;
      documentClass: string;
      disposition: string;
      rationale: string;
      decidedBy: string;
      decidedAt: Date;
    }>(`SELECT decision.id, decision.analysis_job_id AS "analysisJobId", job.case_kind AS "caseKind", job.document_class AS "documentClass", decision.disposition, decision.rationale, decision.decided_by AS "decidedBy", decision.decided_at AS "decidedAt"
        FROM verification_reviewer_decisions decision
        JOIN document_analysis_jobs job ON job.id = decision.analysis_job_id
        ORDER BY decision.decided_at DESC`);
    return rows;
  } finally {
    client.release();
  }
}

export type Actor = { openId: string; role: OperatingRole };

export async function createPostgresVerificationConsent(actor: Actor, input: { scope: "kyc" | "kyb"; subjectReference: string; consentVersion: string; purpose: string; grantedAt: Date; expiresAt?: Date }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; scope: string; subjectReference: string }>("INSERT INTO verification_consents (scope, subject_reference, consent_version, purpose, granted_at, expires_at, captured_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, scope, subject_reference AS \"subjectReference\"", [input.scope, input.subjectReference, input.consentVersion, input.purpose, input.grantedAt, input.expiresAt ?? null, actor.openId]);
    const consent = rows[0];
    if (!consent) throw new Error("PostgreSQL consent insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "verification_consent.captured", "verification_consent", consent.id, JSON.stringify({ scope: consent.scope, subjectReference: consent.subjectReference })]);
    await client.query("COMMIT");
    return consent;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function createPostgresDocumentAnalysisJob(actor: Actor, input: { consentId: string; kycDocumentId?: string; caseKind: "kyc" | "kyb"; documentClass: string; sourceSha256: string; sourceUri: string; mimeType: string; selectedModelTag?: string; selectedModelDigest?: string; selectedModelRole?: "visual_primary" | "text_fallback" }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const consent = await client.query<{ id: string; scope: string; revokedAt: Date | null; expiresAt: Date | null }>("SELECT id, scope, revoked_at AS \"revokedAt\", expires_at AS \"expiresAt\" FROM verification_consents WHERE id=$1 FOR UPDATE", [input.consentId]);
    const record = consent.rows[0];
    if (!record || record.scope !== input.caseKind || record.revokedAt || (record.expiresAt && record.expiresAt <= new Date())) throw new Error("active consent matching the analysis scope is required");
    const hasCompleteModelSelection = Boolean(input.selectedModelTag && input.selectedModelDigest && input.selectedModelRole);
    if (hasCompleteModelSelection !== Boolean(input.selectedModelTag || input.selectedModelDigest || input.selectedModelRole)) throw new Error("selected model tag, digest, and role must be supplied together");
    // Qwen3-VL is the only visual-capable model and DeepSeek is text-only, so a
    // tag and role that do not correspond indicate the provenance was assembled
    // rather than derived from the runtime selector.
    if (hasCompleteModelSelection) {
      const expectedRoleForTag: Record<string, string> = { "qwen3-vl:8b": "visual_primary", "deepseek-r1:8b": "text_fallback" };
      const expectedRole = expectedRoleForTag[input.selectedModelTag as string];
      if (!expectedRole) throw new Error("selected model tag is not an allowlisted analysis model");
      if (expectedRole !== input.selectedModelRole) throw new Error("selected model tag and role do not correspond");
    }
    const { rows } = await client.query<{ id: string; state: string }>("INSERT INTO document_analysis_jobs (consent_id, kyc_document_id, case_kind, document_class, source_sha256, source_uri, mime_type, selected_model_tag, selected_model_digest, selected_model_role, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, state", [input.consentId, input.kycDocumentId ?? null, input.caseKind, input.documentClass, input.sourceSha256, input.sourceUri, input.mimeType, input.selectedModelTag ?? null, input.selectedModelDigest ?? null, input.selectedModelRole ?? null, actor.openId]);
    const job = rows[0];
    if (!job) throw new Error("PostgreSQL analysis job insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "document_analysis_job.created", "document_analysis_job", job.id, JSON.stringify({ caseKind: input.caseKind, documentClass: input.documentClass, sourceSha256: input.sourceSha256, state: job.state, selectedModelTag: input.selectedModelTag ?? null, selectedModelDigest: input.selectedModelDigest ?? null, selectedModelRole: input.selectedModelRole ?? null })]);
    await client.query("COMMIT");
    return job;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function persistPostgresDocumentAnalysisEvidence(actor: Actor, input: { analysisJobId: string; kind: "ocr" | "document_structure" | "visual_consistency" | "presentation_attack_risk" | "engine_unavailable"; disposition: "review_required" | "insufficient_evidence" | "unavailable"; engineName: string; engineVersion: string; modelTag?: string; modelDigest?: string; promptPolicyVersion?: string; evidenceSha256?: string; signals: unknown[]; limitations: string[] }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>("INSERT INTO document_analysis_evidence (analysis_job_id, kind, disposition, engine_name, engine_version, model_tag, model_digest, prompt_policy_version, evidence_sha256, signals, limitations) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) RETURNING id", [input.analysisJobId, input.kind, input.disposition, input.engineName, input.engineVersion, input.modelTag ?? null, input.modelDigest ?? null, input.promptPolicyVersion ?? null, input.evidenceSha256 ?? null, JSON.stringify(input.signals), JSON.stringify(input.limitations)]);
    const evidence = rows[0];
    if (!evidence) throw new Error("PostgreSQL analysis evidence insert did not return a record");
    await client.query("UPDATE document_analysis_jobs SET state=$1, completed_at=now() WHERE id=$2", [input.disposition === "unavailable" ? "unavailable" : "review_required", input.analysisJobId]);
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "document_analysis_evidence.persisted", "document_analysis_evidence", evidence.id, JSON.stringify({ analysisJobId: input.analysisJobId, kind: input.kind, disposition: input.disposition, engineName: input.engineName, modelTag: input.modelTag ?? null, modelDigest: input.modelDigest ?? null })]);
    await client.query("COMMIT");
    return evidence;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresReviewerDecision(actor: Actor, input: { analysisJobId: string; disposition: "approved" | "rejected" | "needs_information" | "escalated"; rationale: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>("INSERT INTO verification_reviewer_decisions (analysis_job_id, disposition, rationale, decided_by) VALUES ($1,$2,$3,$4) RETURNING id", [input.analysisJobId, input.disposition, input.rationale, actor.openId]);
    const decision = rows[0];
    if (!decision) throw new Error("PostgreSQL reviewer decision insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "verification_reviewer_decision.created", "verification_reviewer_decision", decision.id, JSON.stringify({ analysisJobId: input.analysisJobId, disposition: input.disposition })]);
    await client.query("COMMIT");
    return decision;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

type PolicyActor = { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" | "provider_contact" | "cbn_liaison" };

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: PolicyActor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify(metadata)],
  );
}

export async function createPostgresIntegrationConnection(actor: PolicyActor, input: { counterpartyId: string; category: string; environment: "sandbox" | "production"; documentationUrl: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const counterparty = await client.query<{ id: string }>("SELECT id FROM counterparties WHERE id=$1", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("integration connection requires an existing canonical counterparty record");
    const { rows } = await client.query<{ id: string; state: string }>(
      `INSERT INTO integration_connections (counterparty_id, category, environment, documentation_url, state)
       VALUES ($1,$2,$3,$4,'unconfigured')
       RETURNING id, state::text AS state`,
      [input.counterpartyId, input.category, input.environment, input.documentationUrl],
    );
    const connection = rows[0];
    if (!connection) throw new Error("integration connection insert did not return a record");
    await recordActivity(client, actor, "integration_connection.created", "integration_connection", connection.id, { counterpartyId: input.counterpartyId, category: input.category, environment: input.environment, credentialsSupplied: false, activated: false });
    await client.query("COMMIT");
    return connection;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresCorridorPolicy(actor: PolicyActor, input: { corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; regulator: "CBN" | "CBK" | "SARB"; policyVersion: string; effectiveFrom: Date; effectiveTo?: Date; requiresTravelRule: boolean; requiresAuthorisedFxIntermediary: boolean; policyDocumentUri: string }) {
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) throw new Error("corridor policy effective window must end after it begins");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; activationStatus: string }>(
      `INSERT INTO corridor_policies (corridor, regulator, policy_version, effective_from, effective_to, requires_travel_rule, requires_authorised_fx_intermediary, activation_status, policy_document_uri, created_by)
       VALUES ($1::corridor_code,$2,$3,$4,$5,$6,$7,'pending_review',$8,$9)
       RETURNING id, activation_status::text AS "activationStatus"`,
      [input.corridor, input.regulator, input.policyVersion, input.effectiveFrom, input.effectiveTo ?? null, input.requiresTravelRule, input.requiresAuthorisedFxIntermediary, input.policyDocumentUri, actor.openId],
    );
    const policy = rows[0];
    if (!policy) throw new Error("corridor policy insert did not return a record");
    await recordActivity(client, actor, "corridor_policy.created", "corridor_policy", policy.id, { corridor: input.corridor, regulator: input.regulator, policyVersion: input.policyVersion, activationStatus: policy.activationStatus, authorisesExecution: false });
    await client.query("COMMIT");
    return policy;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresRateLock(actor: PolicyActor, input: { marketObservationId: string; corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; expiresAt: Date }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const observation = await client.query<{ id: string; baseAsset: string; quoteAsset: string; rate: string; observedAt: Date }>(
      `SELECT id, base_asset AS "baseAsset", quote_asset AS "quoteAsset", rate::text AS rate, observed_at AS "observedAt"
         FROM market_observations WHERE id=$1`,
      [input.marketObservationId],
    );
    const source = observation.rows[0];
    if (!source) throw new Error("rate lock requires an existing canonical market observation");
    if (input.expiresAt <= new Date()) throw new Error("rate lock expiry must be in the future");
    const { rows } = await client.query<{ id: string; lockedRate: string; status: string }>(
      `INSERT INTO rate_locks (market_observation_id, corridor, base_asset, quote_asset, locked_rate, status, expires_at, created_by)
       VALUES ($1,$2::corridor_code,$3,$4,$5,'locked',$6,$7)
       RETURNING id, locked_rate::text AS "lockedRate", status::text AS status`,
      [source.id, input.corridor, source.baseAsset, source.quoteAsset, source.rate, input.expiresAt, actor.openId],
    );
    const lock = rows[0];
    if (!lock) throw new Error("rate lock insert did not return a record");
    await recordActivity(client, actor, "rate_lock.created", "rate_lock", lock.id, { marketObservationId: source.id, corridor: input.corridor, lockedRate: lock.lockedRate, derivedFromObservationAt: source.observedAt.toISOString(), executionEnabled: false });
    await client.query("COMMIT");
    return lock;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function cancelPostgresRateLock(actor: PolicyActor, rateLockId: string) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string }>("SELECT status::text AS status FROM rate_locks WHERE id=$1 FOR UPDATE", [rateLockId]);
    const existing = current.rows[0];
    if (!existing) throw new Error("rate lock was not found");
    if (existing.status !== "locked") throw new Error("only a locked rate lock can be cancelled");
    const { rows } = await client.query<{ id: string; status: string }>("UPDATE rate_locks SET status='cancelled' WHERE id=$1 RETURNING id, status::text AS status", [rateLockId]);
    const lock = rows[0];
    if (!lock) throw new Error("rate lock cancellation did not return a record");
    await recordActivity(client, actor, "rate_lock.cancelled", "rate_lock", lock.id, { from: existing.status, to: lock.status });
    await client.query("COMMIT");
    return lock;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresRegulatoryDeadline(actor: PolicyActor, input: { regulator: "CBN" | "CBK" | "SARB"; corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; title: string; dueAt: Date; sourceReference: string }) {
  const sourceReference = input.sourceReference.trim();
  // A regulatory deadline without a verifiable source is unusable as evidence:
  // the reminder it produces could not be traced to a published obligation.
  if (sourceReference.length < 8) throw new Error("a regulatory deadline requires a verifiable source reference of at least 8 characters");
  if (!Number.isFinite(input.dueAt.getTime())) throw new Error("a regulatory deadline requires a valid due date");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; status: string }>(
      `INSERT INTO regulatory_deadlines (regulator, corridor, title, due_at, source_reference, status, created_by)
       VALUES ($1,$2::corridor_code,$3,$4,$5,'open',$6)
       RETURNING id, status::text AS status`,
      [input.regulator, input.corridor, input.title, input.dueAt, sourceReference, actor.openId],
    );
    const deadline = rows[0];
    if (!deadline) throw new Error("regulatory deadline insert did not return a record");
    await recordActivity(client, actor, "regulatory_deadline.created", "regulatory_deadline", deadline.id, { regulator: input.regulator, corridor: input.corridor, dueAt: input.dueAt.toISOString(), sourceReference });
    await client.query("COMMIT");
    return deadline;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createPostgresAlertPolicy(actor: PolicyActor, input: { alertType: string; corridor?: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; threshold: Record<string, unknown> }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; enabled: boolean }>(
      `INSERT INTO alert_policies (alert_type, corridor, threshold, enabled, created_by)
       VALUES ($1,$2::corridor_code,$3::jsonb,true,$4)
       RETURNING id, enabled`,
      [input.alertType, input.corridor ?? null, JSON.stringify(input.threshold), actor.openId],
    );
    const policy = rows[0];
    if (!policy) throw new Error("alert policy insert did not return a record");
    await recordActivity(client, actor, "alert_policy.created", "alert_policy", policy.id, { alertType: input.alertType, corridor: input.corridor ?? null, enabled: policy.enabled });
    await client.query("COMMIT");
    return policy;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listPostgresIntegrationConnections() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT ic.id, ic.counterparty_id AS "counterpartyId", c.legal_name AS "counterpartyLegalName", ic.category, ic.environment,
              ic.documentation_url AS "documentationUrl", ic.state::text AS state, ic.last_health_checked_at AS "lastHealthCheckedAt", ic.created_at AS "createdAt"
         FROM integration_connections ic JOIN counterparties c ON c.id = ic.counterparty_id
        ORDER BY ic.created_at DESC`,
    );
    return rows;
  } finally { client.release(); }
}

/**
 * Provider credential configuration and verified activation.
 *
 * The rule the whole platform rests on is that an integration may only reach
 * `active` after a real health check against the real provider endpoint has
 * succeeded. Everything below is written so that rule cannot be sidestepped:
 * credentials are stored as a *reference* to a deployment secret and never as a
 * value, and the only function that writes `active` requires a health-check
 * outcome it did not produce itself.
 */

/** A secret reference names a deployment secret; it never carries the secret. */
const SECRET_REFERENCE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Values that look like credentials rather than references. A caller pasting an
 * actual key into this field is the most likely way a secret would end up in the
 * database, so it is refused explicitly rather than merely discouraged.
 */
const CREDENTIAL_SHAPED = [
  /^sk_/i, /^pk_/i, /^rk_/i,            // common key prefixes
  /^Bearer\s/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,          // long base64 blob
  /^[0-9a-f]{32,}$/i,                    // long hex blob
  /^-----BEGIN /,                        // PEM material
  /^ey[A-Za-z0-9_-]+\./,                 // JWT
];

export function assertIsSecretReferenceNotSecret(candidate: string): void {
  const value = candidate.trim();
  for (const pattern of CREDENTIAL_SHAPED) {
    if (pattern.test(value)) {
      throw new Error("secret reference looks like a credential value; supply the name of a deployment secret instead");
    }
  }
  if (!SECRET_REFERENCE_PATTERN.test(value)) {
    throw new Error("secret reference must be an uppercase deployment secret name, for example PROVIDER_FX_API_KEY");
  }
}

/**
 * Records which deployment secret backs an integration and moves it to
 * `credential_pending`. This deliberately does not activate anything: supplying
 * a credential reference is a claim, and the health check is what tests it.
 */
export async function configurePostgresIntegrationCredential(
  actor: PolicyActor,
  input: { integrationConnectionId: string; secretReference: string; endpointUrl: string },
) {
  assertIsSecretReferenceNotSecret(input.secretReference);
  const endpoint = normaliseProviderEndpoint(input.endpointUrl);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; state: string; secretReference: string | null }>(
      `SELECT id, state::text AS state, secret_reference AS "secretReference"
         FROM integration_connections WHERE id=$1 FOR UPDATE`,
      [input.integrationConnectionId],
    );
    const connection = existing.rows[0];
    if (!connection) throw new Error("integration connection does not exist");
    if (connection.state === "active") {
      // Re-pointing a live integration's credential would silently change which
      // provider it talks to, so it must be suspended first.
      throw new Error("suspend the integration before changing the credential of an active connection");
    }

    const { rows } = await client.query<{ id: string; state: string }>(
      `UPDATE integration_connections
          SET secret_reference=$2,
              documentation_url=$3,
              state='credential_pending',
              last_health_checked_at=NULL,
              last_health_result=NULL
        WHERE id=$1
        RETURNING id, state::text AS state`,
      [input.integrationConnectionId, input.secretReference.trim(), endpoint],
    );
    const updated = rows[0];
    if (!updated) throw new Error("integration credential update did not return a record");

    await recordActivity(client, actor, "integration_connection.credential_configured", "integration_connection", updated.id, {
      // The reference name is recorded; no credential value exists to record.
      secretReference: input.secretReference.trim(),
      // The previous reference is recorded alongside the new one. An audit
      // entry saying only what a value became cannot answer the question an
      // auditor actually asks, which is what it was changed from.
      previousSecretReference: connection.secretReference,
      endpoint,
      previousState: connection.state,
      state: updated.state,
      credentialValuePersisted: false,
      activated: false,
    });
    await client.query("COMMIT");
    return updated;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

/**
 * Provider endpoints receive an integration credential during the activation
 * probe. HTTPS is therefore necessary but insufficient: the destination must
 * be a deployment-owned DNS name, explicitly allow-listed outside the request,
 * and never an IP literal that could target loopback, RFC1918, link-local, or a
 * metadata service.
 */
export function providerEndpointAllowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS;
  if (!raw || raw.trim() === "") {
    throw new Error("UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS must list approved provider DNS hosts");
  }
  const hosts = new Set(
    raw
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (hosts.size === 0) {
    throw new Error("UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS must list approved provider DNS hosts");
  }
  for (const host of Array.from(hosts)) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
      throw new Error("UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS contains an invalid DNS host");
    }
  }
  return hosts;
}

export function normaliseProviderEndpoint(candidate: string, env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    throw new Error("provider endpoint must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new Error("provider endpoint must use https");
  if (url.username || url.password) throw new Error("provider endpoint must not embed credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || isIP(hostname) !== 0) {
    throw new Error("provider endpoint must use an approved DNS host, not an IP literal");
  }
  if (!providerEndpointAllowedHosts(env).has(hostname)) {
    throw new Error("provider endpoint host is not approved for credential-bearing probes");
  }
  return url.toString();
}

/** The outcome of a real health check, produced by the caller, not by the database. */
export type ProviderHealthCheckOutcome = {
  reachable: boolean;
  httpStatus: number | null;
  observedAt: Date;
  detail: string;
  endpoint: string;
};

/**
 * The only path to `active`.
 *
 * It refuses unless the supplied outcome actually passed, and it refuses if the
 * integration has no credential reference — so activation cannot happen before
 * configuration, and cannot happen on a failed or unreachable check. The failure
 * path is equally explicit: a failed check moves the integration to `failed` and
 * records why, rather than leaving it in a state that reads as "not tried yet".
 */
export async function activatePostgresIntegrationConnection(
  actor: PolicyActor,
  input: { integrationConnectionId: string; outcome: ProviderHealthCheckOutcome },
) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; state: string; secretReference: string | null }>(
      `SELECT id, state::text AS state, secret_reference AS "secretReference"
         FROM integration_connections WHERE id=$1 FOR UPDATE`,
      [input.integrationConnectionId],
    );
    const connection = existing.rows[0];
    if (!connection) throw new Error("integration connection does not exist");
    if (!connection.secretReference) {
      throw new Error("configure a credential reference before attempting activation");
    }

    const passed = input.outcome.reachable && input.outcome.httpStatus !== null && input.outcome.httpStatus >= 200 && input.outcome.httpStatus < 300;
    const nextState = passed ? "active" : "failed";

    const { rows } = await client.query<{ id: string; state: string; lastHealthCheckedAt: Date }>(
      `UPDATE integration_connections
          SET state=$2::integration_state,
              last_health_checked_at=$3,
              last_health_result=$4::jsonb
        WHERE id=$1
        RETURNING id, state::text AS state, last_health_checked_at AS "lastHealthCheckedAt"`,
      [
        input.integrationConnectionId,
        nextState,
        input.outcome.observedAt,
        JSON.stringify({
          reachable: input.outcome.reachable,
          httpStatus: input.outcome.httpStatus,
          detail: input.outcome.detail,
          endpoint: input.outcome.endpoint,
          observedAt: input.outcome.observedAt.toISOString(),
        }),
      ],
    );
    const updated = rows[0];
    if (!updated) throw new Error("integration activation did not return a record");

    await recordActivity(client, actor, passed ? "integration_connection.activated" : "integration_connection.activation_refused", "integration_connection", updated.id, {
      state: updated.state,
      healthCheckPassed: passed,
      httpStatus: input.outcome.httpStatus,
      reachable: input.outcome.reachable,
      detail: input.outcome.detail,
      endpoint: input.outcome.endpoint,
      credentialValuePersisted: false,
    });
    await client.query("COMMIT");
    return { ...updated, healthCheckPassed: passed, detail: input.outcome.detail };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

/** Suspends a live integration, which is the prerequisite for re-credentialling. */
export async function suspendPostgresIntegrationConnection(actor: PolicyActor, input: { integrationConnectionId: string; reason: string }) {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new Error("suspension requires a stated reason");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; state: string }>(
      `UPDATE integration_connections SET state='suspended'
        WHERE id=$1 AND state IN ('active','failed','verification_pending')
        RETURNING id, state::text AS state`,
      [input.integrationConnectionId],
    );
    const updated = rows[0];
    if (!updated) throw new Error("only an active, failed, or verifying integration can be suspended");
    await recordActivity(client, actor, "integration_connection.suspended", "integration_connection", updated.id, { reason, state: updated.state });
    await client.query("COMMIT");
    return updated;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

/**
 * The attributable history of every credential change, activation attempt, and
 * suspension for one integration.
 *
 * This reads the append-only activity trail rather than a separate audit table,
 * so the history cannot drift from what was actually recorded at the time of
 * the action: there is one write, not two that must agree. Reads are ordered
 * newest first because the question being asked is almost always "what changed
 * most recently".
 */
export type CredentialAuditEntry = {
  id: string;
  action: string;
  actorSubject: string;
  actorRole: string;
  occurredAt: Date;
  secretReference: string | null;
  previousSecretReference: string | null;
  endpoint: string | null;
  state: string | null;
  healthCheckPassed: boolean | null;
  httpStatus: number | null;
  detail: string | null;
  reason: string | null;
};

export async function listPostgresCredentialAuditTrail(input: { integrationConnectionId: string; limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<CredentialAuditEntry>(
      `SELECT id,
              action,
              actor_subject AS "actorSubject",
              actor_role::text AS "actorRole",
              occurred_at AS "occurredAt",
              metadata->>'secretReference' AS "secretReference",
              metadata->>'previousSecretReference' AS "previousSecretReference",
              metadata->>'endpoint' AS "endpoint",
              metadata->>'state' AS "state",
              (metadata->>'healthCheckPassed')::boolean AS "healthCheckPassed",
              (metadata->>'httpStatus')::int AS "httpStatus",
              metadata->>'detail' AS "detail",
              metadata->>'reason' AS "reason"
         FROM activity_events
        WHERE object_type='integration_connection'
          AND object_id=$1
          AND action IN (
            'integration_connection.created',
            'integration_connection.credential_configured',
            'integration_connection.activated',
            'integration_connection.activation_refused',
            'integration_connection.suspended'
          )
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2`,
      [input.integrationConnectionId, limit],
    );
    return rows;
  } finally { client.release(); }
}

/** Detailed integration view including credential-reference presence, never a value. */
export async function listPostgresIntegrationCredentialStatus() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT ic.id, c.legal_name AS "counterpartyLegalName", ic.category, ic.environment,
              ic.documentation_url AS "endpoint", ic.state::text AS state,
              (ic.secret_reference IS NOT NULL) AS "credentialConfigured",
              ic.secret_reference AS "secretReference",
              ic.last_health_checked_at AS "lastHealthCheckedAt",
              ic.last_health_result AS "lastHealthResult"
         FROM integration_connections ic JOIN counterparties c ON c.id = ic.counterparty_id
        ORDER BY ic.created_at DESC`,
    );
    return rows;
  } finally { client.release(); }
}

export async function listPostgresCorridorPolicies() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT id, corridor::text AS corridor, regulator, policy_version AS "policyVersion", effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
              requires_travel_rule AS "requiresTravelRule", requires_authorised_fx_intermediary AS "requiresAuthorisedFxIntermediary",
              activation_status::text AS "activationStatus", policy_document_uri AS "policyDocumentUri", created_by AS "createdBy", created_at AS "createdAt"
         FROM corridor_policies ORDER BY created_at DESC`,
    );
    return rows;
  } finally { client.release(); }
}

export async function listPostgresRateLocks() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT id, market_observation_id AS "marketObservationId", corridor::text AS corridor, base_asset AS "baseAsset", quote_asset AS "quoteAsset",
              locked_rate::text AS "lockedRate", status::text AS status, expires_at AS "expiresAt", created_by AS "createdBy", created_at AS "createdAt"
         FROM rate_locks ORDER BY created_at DESC`,
    );
    return rows;
  } finally { client.release(); }
}

export async function listPostgresAlertPolicies() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT id, alert_type AS "alertType", corridor::text AS corridor, threshold, enabled, created_by AS "createdBy", created_at AS "createdAt"
         FROM alert_policies ORDER BY created_at DESC`,
    );
    return rows;
  } finally { client.release(); }
}

/**
 * Canonical PostgreSQL alert delivery. Nothing is invented: a delivery record is
 * written only for alert policies that actually exist and are enabled for the
 * corridor, and the recorded state reflects the real outcome of the notification
 * attempt rather than an assumed success.
 */
async function notifyPostgresAlertPolicies(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  actor: PolicyActor,
  alertType: "liquidity_threshold" | "payment_failure" | "compliance_flag" | "regulatory_deadline",
  corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR" | undefined,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
) {
  const { rows } = await client.query(
    `SELECT id FROM alert_policies
      WHERE alert_type = $1 AND enabled = true AND (corridor IS NULL OR corridor::text = $2)`,
    [alertType, corridor ?? null],
  );
  const policyIds = rows.map(row => String(row.id));
  if (!policyIds.length) return { delivered: false, policyIds };
  const { notifyOwner } = await import("./_core/notification");
  const delivered = await notifyOwner({ title, content });
  const correlationId = randomUUID();
  const payloadHash = createHash("sha256").update(`${title}\n${content}`).digest("hex");
  for (const policyId of policyIds) {
    await client.query(
      `INSERT INTO notification_deliveries (alert_policy_id, alert_type, delivery_state, destination, correlation_id, payload_hash)
       VALUES ($1,$2,$3,'project_owner',$4,$5)`,
      [policyId, alertType, delivered ? "accepted" : "unavailable", correlationId, payloadHash],
    );
  }
  await recordActivity(client, actor, "operational_alert.delivery_attempted", "alert_delivery", correlationId, { ...metadata, alertType, policyIds, delivered });
  return { delivered, policyIds };
}

export async function evaluatePostgresRegulatoryDeadlines(actor: PolicyActor, now = new Date()) {
  const horizonHours = 72;
  const horizon = new Date(now.getTime() + horizonHours * 3_600_000);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; regulator: string; corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; title: string; dueAt: Date; lastRemindedAt: Date | null }>(
      `SELECT id, regulator, corridor::text AS corridor, title, due_at AS "dueAt", last_reminded_at AS "lastRemindedAt"
         FROM regulatory_deadlines WHERE status = 'open' ORDER BY due_at ASC FOR UPDATE`,
    );
    let reminded = 0;
    for (const deadline of rows) {
      const alreadyRemindedToday = deadline.lastRemindedAt !== null && new Date(deadline.lastRemindedAt).toDateString() === now.toDateString();
      if (deadline.dueAt > horizon || alreadyRemindedToday) continue;
      await notifyPostgresAlertPolicies(
        client as never,
        actor,
        "regulatory_deadline",
        deadline.corridor,
        `UmojaFlowOS ${deadline.regulator} reporting deadline`,
        `${deadline.title} is due at ${deadline.dueAt.toISOString()}. Review the source evidence and report-pack status before the deadline.`,
        { deadlineId: deadline.id, regulator: deadline.regulator, dueAt: deadline.dueAt.toISOString() },
      );
      await client.query("UPDATE regulatory_deadlines SET last_reminded_at = $1 WHERE id = $2", [now, deadline.id]);
      reminded += 1;
    }
    const expiry = await client.query("UPDATE rate_locks SET status='expired' WHERE status='locked' AND expires_at <= $1 RETURNING id", [now]);
    const expired = expiry.rowCount ?? 0;
    await recordActivity(client, actor, "regulatory_deadline.evaluated", "regulatory_deadline", randomUUID(), { evaluated: rows.length, reminded, expiredRateLocks: expired, horizonHours, evaluatedAt: now.toISOString() });
    await client.query("COMMIT");
    return { evaluated: rows.length, reminded, expired };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function describePostgresTableColumns(tableName: string) {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ columnName: string; dataType: string }>(
      `SELECT column_name AS "columnName", data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position`,
      [tableName],
    );
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresActivityEventsForObjects(objectIds: string[]) {
  if (objectIds.length === 0) return [];
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ id: string; actorSubject: string; actorRole: string; action: string; objectType: string; objectId: string; metadata: unknown; occurredAt: Date }>(
      `SELECT id, actor_subject AS "actorSubject", actor_role AS "actorRole", action, object_type AS "objectType", object_id AS "objectId", metadata, occurred_at AS "occurredAt"
         FROM activity_events
        WHERE object_id = ANY($1::uuid[])
        ORDER BY occurred_at ASC`,
      [objectIds],
    );
    return rows;
  } finally {
    client.release();
  }
}

const appendOnlyEvidenceTables = [
  "activity_events",
  "document_analysis_evidence",
  "verification_reviewer_decisions",
  "policy_decisions",
  "postgres_cutover_runs",
  "postgres_cutover_table_reconciliations",
  "notification_deliveries",
  "counterparty_risk_assessments",
  "market_observations",
] as const;

export async function getPostgresPrivilegeBoundary() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ table: string; insert: boolean; update: boolean; delete: boolean }>(
      `SELECT tablename AS "table",
              has_table_privilege(tablename, 'INSERT') AS insert,
              has_table_privilege(tablename, 'UPDATE') AS update,
              has_table_privilege(tablename, 'DELETE') AS delete
         FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`,
    );
    const ownership = await client.query<{ owned: string }>("SELECT count(*)::text AS owned FROM pg_tables WHERE schemaname='public' AND tableowner = current_user");
    const createRights = await client.query<{ allowed: boolean }>("SELECT has_schema_privilege('public', 'CREATE') AS allowed");
    const appendOnlyViolations = rows
      .filter(row => (appendOnlyEvidenceTables as readonly string[]).includes(row.table))
      .filter(row => row.update || row.delete)
      .map(row => row.table);
    return {
      tables: rows,
      appendOnlyViolations,
      deletableTables: rows.filter(row => row.delete).map(row => row.table),
      ownsSchemaObjects: Number(ownership.rows[0]?.owned ?? 0) > 0,
      canCreateInSchema: createRights.rows[0]?.allowed === true,
    };
  } finally {
    client.release();
  }
}

export async function closePostgresPool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function listPostgresLegalEntities() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT id, legal_name AS "legalName", jurisdiction, registration_identifier AS "registrationIdentifier", created_at AS "createdAt"
         FROM legal_entities ORDER BY legal_name ASC`,
    );
    return rows;
  } finally { client.release(); }
}

/**
 * Records a scheduled job in the canonical PostgreSQL schema. The Heartbeat task
 * identifier is supplied by the platform scheduler, so nothing about execution is
 * assumed here: a job row is only written once the scheduler has accepted it.
 */
export async function createPostgresScheduledJob(actor: PolicyActor, input: { purpose: "regulatory_deadline_reminders" | "counterparty_risk_reviews"; taskUid: string; cronExpression: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM scheduled_jobs WHERE purpose=$1 AND enabled=true", [input.purpose]);
    if (existing.rows[0]) throw new Error("An enabled scheduled job already exists for this purpose");
    const { rows } = await client.query<{ id: string; purpose: string; cronExpression: string; enabled: boolean }>(
      `INSERT INTO scheduled_jobs (purpose, schedule_cron_task_uid, cron_expression, enabled, created_by)
       VALUES ($1,$2,$3,true,$4)
       RETURNING id, purpose::text AS purpose, cron_expression AS "cronExpression", enabled`,
      [input.purpose, input.taskUid, input.cronExpression, actor.openId],
    );
    const job = rows[0];
    if (!job) throw new Error("scheduled job insert did not return a record");
    await recordActivity(client, actor, "scheduled_job.created", "scheduled_job", job.id, { purpose: input.purpose, cronExpression: input.cronExpression, taskUid: input.taskUid });
    await client.query("COMMIT");
    return job;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

/**
 * Counts rows in an allowlisted canonical table. Used by regressions to prove a
 * fail-closed path wrote nothing; the allowlist prevents this from becoming a
 * general-purpose query surface.
 */
export async function countPostgresRows(table: "document_analysis_jobs" | "activity_events" | "kyc_documents" | "verification_consents") {
  const allowed = new Set(["document_analysis_jobs", "activity_events", "kyc_documents", "verification_consents"]);
  if (!allowed.has(table)) throw new Error("table is not permitted for row counting");
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    return Number(rows[0]?.count ?? "0");
  } finally { client.release(); }
}

/**
 * Auditor-readable treasury rebalancing recommendation ledger. Every row is
 * derived from a reconciled balance and an approved buffer policy; the read
 * exposes the calculation evidence, both actors, and the expiry so an approval
 * decision can be reviewed independently. No balance is computed here.
 */
export async function listPostgresTreasuryRecommendations() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string; corridor: string; currency: string; reconciledAvailableBalance: string;
      reconciledAt: Date; balanceSourceReference: string; verifiedNearTermFundingGap: string;
      fundingGapSourceReference: string; minimumBufferAmount: string; targetBufferAmount: string;
      computedRecommendationAmount: string; calculationEvidence: unknown; status: string;
      proposedBy: string; proposedAt: Date; decidedBy: string | null; decidedAt: Date | null;
      decisionReason: string | null; expiresAt: Date;
    }>(
      `SELECT id, corridor::text AS corridor, currency,
              reconciled_available_balance::text AS "reconciledAvailableBalance",
              reconciled_at AS "reconciledAt",
              balance_source_reference AS "balanceSourceReference",
              verified_near_term_funding_gap::text AS "verifiedNearTermFundingGap",
              funding_gap_source_reference AS "fundingGapSourceReference",
              minimum_buffer_amount::text AS "minimumBufferAmount",
              target_buffer_amount::text AS "targetBufferAmount",
              computed_recommendation_amount::text AS "computedRecommendationAmount",
              calculation_evidence AS "calculationEvidence",
              status::text AS status, proposed_by AS "proposedBy", proposed_at AS "proposedAt",
              decided_by AS "decidedBy", decided_at AS "decidedAt",
              decision_reason AS "decisionReason", expires_at AS "expiresAt"
         FROM treasury_rebalancing_recommendations
        ORDER BY proposed_at DESC
        LIMIT 100`,
    );
    return rows;
  } finally { client.release(); }
}

/**
 * Auditor-readable approved treasury buffer policies. A recommendation cannot
 * be proposed without an active one, so the console shows whether any exists
 * instead of offering an action that would always fail closed.
 */
export async function listPostgresTreasuryBufferPolicies() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string; corridor: string; currency: string; approvedDailyOutflow: string;
      minimumBufferPct: string; targetBufferPct: string; maxRecommendationPctOfTarget: string;
      effectiveFrom: Date; effectiveTo: Date | null; approvedBy: string;
    }>(
      `SELECT id, corridor::text AS corridor, currency,
              approved_daily_outflow::text AS "approvedDailyOutflow",
              minimum_buffer_pct::text AS "minimumBufferPct",
              target_buffer_pct::text AS "targetBufferPct",
              max_recommendation_pct_of_target::text AS "maxRecommendationPctOfTarget",
              effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
              approved_by AS "approvedBy"
         FROM treasury_buffer_policies
        ORDER BY effective_from DESC
        LIMIT 100`,
    );
    return rows;
  } finally { client.release(); }
}


export type InternalLedgerProjectionInput = {
  transferId: string;
  correlationId: string;
  currency: "NGN" | "KES" | "ZAR" | "USD" | "USDC" | "USDT";
  amountMinor: string;
  debitAccountId: string;
  creditAccountId: string;
  postedAt: Date;
  evidenceSha256: string;
};

/**
 * Persist an accepted TigerBeetle fact. This function is intentionally limited
 * to immutable accounting evidence: it neither updates payment_orders nor
 * treats the fact as settlement finality. A separate reconciliation procedure
 * must record a matching PostgreSQL projection before any lifecycle changes.
 */
export async function recordInternalLedgerProjection(input: InternalLedgerProjectionInput) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (input.debitAccountId === input.creditAccountId) throw new Error("ledger projection requires distinct accounts");
    const accounts = await client.query<{ tigerbeetleAccountId: string; currency: string }>(
      `SELECT tigerbeetle_account_id::text AS "tigerbeetleAccountId", currency
         FROM ledger_account_bindings
        WHERE tigerbeetle_account_id = ANY($1::bigint[]) FOR KEY SHARE`,
      [[input.debitAccountId, input.creditAccountId]],
    );
    if (accounts.rows.length !== 2 || accounts.rows.some(row => row.currency !== input.currency)) {
      throw new Error("ledger account bindings are missing or do not match the transfer currency");
    }
    const inserted = await client.query<{ id: string; reconciliationState: string }>(
      `INSERT INTO tigerbeetle_transfer_facts
        (tigerbeetle_transfer_id, correlation_id, currency, amount_minor, debit_account_id, credit_account_id, posted_at, evidence_sha256)
       VALUES ($1::bigint, $2, $3, $4::numeric, $5::bigint, $6::bigint, $7, $8)
       ON CONFLICT (tigerbeetle_transfer_id) DO NOTHING
       RETURNING id, reconciliation_state AS "reconciliationState"`,
      [input.transferId, input.correlationId, input.currency, input.amountMinor, input.debitAccountId, input.creditAccountId, input.postedAt, input.evidenceSha256],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query<{
        correlationId: string; currency: string; amountMinor: string; debitAccountId: string; creditAccountId: string; evidenceSha256: string; reconciliationState: string;
      }>(
        `SELECT correlation_id AS "correlationId", currency, amount_minor::text AS "amountMinor",
                debit_account_id::text AS "debitAccountId", credit_account_id::text AS "creditAccountId",
                evidence_sha256 AS "evidenceSha256", reconciliation_state AS "reconciliationState"
           FROM tigerbeetle_transfer_facts WHERE tigerbeetle_transfer_id=$1::bigint`,
        [input.transferId],
      );
      const fact = existing.rows[0];
      if (!fact || fact.correlationId !== input.correlationId || fact.currency !== input.currency || fact.amountMinor !== input.amountMinor || fact.debitAccountId !== input.debitAccountId || fact.creditAccountId !== input.creditAccountId || fact.evidenceSha256 !== input.evidenceSha256) {
        throw new Error("existing TigerBeetle transfer evidence does not match the signed projection");
      }
      await client.query("COMMIT");
      return { recorded: false, reconciliationState: fact.reconciliationState };
    }
    const fact = inserted.rows[0];
    await client.query(
      `INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata)
       VALUES ($1, 'admin', 'ledger.tigerbeetle_fact_projected', 'tigerbeetle_transfer_fact', $2, $3::jsonb)`,
      ["payment-engine-internal", fact.id, JSON.stringify({ transferId: input.transferId, correlationId: input.correlationId, currency: input.currency, amountMinor: input.amountMinor, evidenceSha256: input.evidenceSha256, source: "signed-payment-engine-projection" })],
    );
    await client.query("COMMIT");
    return { recorded: true, reconciliationState: fact.reconciliationState };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
