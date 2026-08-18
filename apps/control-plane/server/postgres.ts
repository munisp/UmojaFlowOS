import { Pool } from "pg";

const localDevelopmentConfig = {
  host: "/var/run/postgresql",
  database: "umojaflowos_dev",
  user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
};

let pool: Pool | undefined;

function getPool() {
  if (!pool) {
    pool = process.env.POSTGRES_DATABASE_URL
      ? new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL })
      : new Pool(localDevelopmentConfig);
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

const canonicalTables = [
  "activity_events", "alert_policies", "beneficiaries", "compliance_cases", "corridor_policies", "counterparties", "counterparty_authorizations", "customers", "document_analysis_evidence", "document_analysis_jobs", "integration_connections", "kyc_documents", "legal_entities", "liquidity_positions", "market_observations", "notification_deliveries", "payment_legs", "payment_orders", "policy_decisions", "rate_locks", "regulatory_deadlines", "regulatory_reports", "sar_str_filings", "scheduled_jobs", "user_role_assignments", "verification_consents", "verification_reviewer_decisions",
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

export async function createPostgresCounterparty(
  actor: { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" },
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
  actor: { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" },
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
      submittedBy: string;
      submittedAt: Date;
      completedAt: Date | null;
    }>("SELECT id, consent_id AS \"consentId\", kyc_document_id AS \"kycDocumentId\", case_kind AS \"caseKind\", document_class AS \"documentClass\", source_sha256 AS \"sourceSha256\", source_uri AS \"sourceUri\", mime_type AS \"mimeType\", state, submitted_by AS \"submittedBy\", submitted_at AS \"submittedAt\", completed_at AS \"completedAt\" FROM document_analysis_jobs ORDER BY submitted_at DESC");
    return rows;
  } finally {
    client.release();
  }
}

type Actor = { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" };

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

export async function createPostgresDocumentAnalysisJob(actor: Actor, input: { consentId: string; kycDocumentId?: string; caseKind: "kyc" | "kyb"; documentClass: string; sourceSha256: string; sourceUri: string; mimeType: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const consent = await client.query<{ id: string; scope: string; revokedAt: Date | null; expiresAt: Date | null }>("SELECT id, scope, revoked_at AS \"revokedAt\", expires_at AS \"expiresAt\" FROM verification_consents WHERE id=$1 FOR UPDATE", [input.consentId]);
    const record = consent.rows[0];
    if (!record || record.scope !== input.caseKind || record.revokedAt || (record.expiresAt && record.expiresAt <= new Date())) throw new Error("active consent matching the analysis scope is required");
    const { rows } = await client.query<{ id: string; state: string }>("INSERT INTO document_analysis_jobs (consent_id, kyc_document_id, case_kind, document_class, source_sha256, source_uri, mime_type, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, state", [input.consentId, input.kycDocumentId ?? null, input.caseKind, input.documentClass, input.sourceSha256, input.sourceUri, input.mimeType, actor.openId]);
    const job = rows[0];
    if (!job) throw new Error("PostgreSQL analysis job insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "document_analysis_job.created", "document_analysis_job", job.id, JSON.stringify({ caseKind: input.caseKind, documentClass: input.documentClass, sourceSha256: input.sourceSha256, state: job.state })]);
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

export async function createPostgresRegulatoryReportDraft(actor: Actor, input: { regulator: "CBN" | "CBK" | "SARB"; corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; reportType: string; periodStart: Date; periodEnd: Date; legalEntityId: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; regulator: string; corridor: string; reportType: string; status: string }>("INSERT INTO regulatory_reports (regulator, corridor, report_type, period_start, period_end, legal_entity_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, regulator, corridor, report_type AS \"reportType\", status", [input.regulator, input.corridor, input.reportType, input.periodStart, input.periodEnd, input.legalEntityId]);
    const report = rows[0];
    if (!report) throw new Error("PostgreSQL regulatory report insert did not return a record");
    await client.query("INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)", [actor.openId, actor.role, "regulatory_report.draft_created", "regulatory_report", report.id, JSON.stringify({ regulator: report.regulator, corridor: report.corridor, reportType: report.reportType, status: report.status, legalEntityId: input.legalEntityId })]);
    await client.query("COMMIT");
    return report;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function closePostgresPool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
