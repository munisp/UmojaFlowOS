import { getPool, listPostgresActivityEventsForObjects, type Actor } from "./postgres";

export type CustomerArchetype = "importer" | "exporter" | "intercompany_rebalancing" | "payroll_operator";
export type CustomerTier = "smb" | "mid" | "enterprise";
export type CustomerGateDecision = "approved" | "blocked";

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, "customer", objectId, JSON.stringify(metadata)],
  );
}

/**
 * OM §4.2/§4.3 S1/S4: archetype, tier, and the use-case narrative that Gate
 * G1 is decided against. Nullable on the customer record because these are
 * captured after creation, not at the minimal creation step.
 */
export async function updatePostgresCustomerProfile(actor: Actor, input: { customerId: string; archetype?: CustomerArchetype; tier?: CustomerTier; useCaseNarrative?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ id: string }>("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [input.customerId]);
    if (!current.rows[0]) throw new Error("customer record was not found");
    await client.query(
      "UPDATE customers SET archetype = COALESCE($1::customer_archetype, archetype), tier = COALESCE($2::customer_tier, tier), use_case_narrative = COALESCE($3, use_case_narrative) WHERE id=$4",
      [input.archetype ?? null, input.tier ?? null, input.useCaseNarrative ?? null, input.customerId],
    );
    await recordActivity(client, actor, "customer.profile_updated", input.customerId, { archetype: input.archetype, tier: input.tier, useCaseNarrativeLength: input.useCaseNarrative?.trim().length });
    await client.query("COMMIT");
    return { id: input.customerId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** OM §4.4 evidence item 11/12: the destination-counterparty list Gate G1 is evaluated against. */
export async function recordCustomerDestinationCounterparty(actor: Actor, input: { customerId: string; counterpartyName: string; destinationJurisdiction: string; invoiceReference?: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const customer = await client.query<{ id: string }>("SELECT id FROM customers WHERE id=$1 FOR KEY SHARE", [input.customerId]);
    if (!customer.rows[0]) throw new Error("a canonical customer record is required before recording a destination counterparty");
    const { rows } = await client.query<{ id: string; customerId: string; counterpartyName: string; destinationJurisdiction: string; invoiceReference: string | null; createdBy: string; createdAt: Date }>(
      `INSERT INTO customer_destination_counterparties (customer_id, counterparty_name, destination_jurisdiction, invoice_reference, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, customer_id AS "customerId", counterparty_name AS "counterpartyName", destination_jurisdiction AS "destinationJurisdiction", invoice_reference AS "invoiceReference", created_by AS "createdBy", created_at AS "createdAt"`,
      [input.customerId, input.counterpartyName, input.destinationJurisdiction, input.invoiceReference ?? null, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("destination counterparty insert did not return a record");
    await recordActivity(client, actor, "customer.destination_counterparty_added", input.customerId, { counterpartyName: input.counterpartyName, destinationJurisdiction: input.destinationJurisdiction });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * OM §4.6 Gate G1 — use-case admissibility. Pass criterion: "use case is
 * permitted in originating and destination jurisdictions; no sanctions
 * match; BO chain clean." The platform cannot evaluate sanctions/BO chain
 * automatically, so this stays a human decision — the one guard enforced
 * here is that an "approved" decision cannot be recorded against an empty
 * evidentiary basis (no narrative, no declared destination counterparty).
 *
 * OM ownership is "Compliance + Country Lead"; this platform has no Country
 * Lead role, so the gate is restricted to compliance_officer/admin only —
 * a known gap against the OM, not a substitution.
 */
export async function decideCustomerUseCaseGate(actor: Actor, input: { customerId: string; decision: CustomerGateDecision; rationale: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const customer = await client.query<{ id: string; useCaseNarrative: string | null }>("SELECT id, use_case_narrative AS \"useCaseNarrative\" FROM customers WHERE id=$1 FOR UPDATE", [input.customerId]);
    if (!customer.rows[0]) throw new Error("customer record was not found");
    if (input.decision === "approved") {
      if (!customer.rows[0].useCaseNarrative?.trim()) throw new Error("a use-case narrative is required before Gate G1 can be approved");
      const counterparties = await client.query<{ id: string }>("SELECT id FROM customer_destination_counterparties WHERE customer_id=$1 LIMIT 1", [input.customerId]);
      if (!counterparties.rows[0]) throw new Error("at least one destination counterparty is required before Gate G1 can be approved");
    }
    const { rows } = await client.query<{ id: string; decision: CustomerGateDecision; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>(
      `INSERT INTO customer_use_case_gate_decisions (customer_id, decision, rationale, decided_by, decided_role)
       VALUES ($1,$2::customer_gate_decision,$3,$4,$5::operating_role)
       RETURNING id, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"`,
      [input.customerId, input.decision, input.rationale, actor.openId, actor.role],
    );
    const record = rows[0];
    if (!record) throw new Error("use-case gate decision insert did not return a record");
    await recordActivity(client, actor, "customer.use_case_gate_decided", input.customerId, { decision: input.decision, decidedBy: actor.openId });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listCustomerDestinationCounterparties(customerId: string) {
  const { rows } = await getPool().query<{ id: string; customerId: string; counterpartyName: string; destinationJurisdiction: string; invoiceReference: string | null; createdBy: string; createdAt: Date }>(
    `SELECT id, customer_id AS "customerId", counterparty_name AS "counterpartyName", destination_jurisdiction AS "destinationJurisdiction", invoice_reference AS "invoiceReference", created_by AS "createdBy", created_at AS "createdAt"
       FROM customer_destination_counterparties WHERE customer_id=$1 ORDER BY created_at DESC`,
    [customerId],
  );
  return rows;
}

export async function listCustomerUseCaseGateDecisions(customerId: string) {
  const { rows } = await getPool().query<{ id: string; decision: CustomerGateDecision; rationale: string; decidedBy: string; decidedRole: string; decidedAt: Date }>(
    `SELECT id, decision, rationale, decided_by AS "decidedBy", decided_role AS "decidedRole", decided_at AS "decidedAt"
       FROM customer_use_case_gate_decisions WHERE customer_id=$1 ORDER BY decided_at DESC`,
    [customerId],
  );
  return rows;
}

/**
 * The full read backing the customer workspace: identity + profile, the G1
 * evidentiary basis, per-customer KYC documents, the analysis-job pipeline
 * linked to those documents (a distinct, optionally-linked pipeline — see
 * KycEvidenceWorkspace), and the reconstructed activity feed. This is a
 * composed read, not a stored view: every field traces to a real row.
 */
export async function getCustomerWorkspace(customerId: string) {
  const customerResult = await getPool().query<{ id: string; legalName: string; registrationIdentifier: string; kycStatus: string; archetype: CustomerArchetype | null; tier: CustomerTier | null; useCaseNarrative: string | null; createdAt: Date }>(
    `SELECT id, legal_name AS "legalName", registration_identifier AS "registrationIdentifier", kyc_status AS "kycStatus", archetype, tier, use_case_narrative AS "useCaseNarrative", created_at AS "createdAt"
       FROM customers WHERE id=$1`,
    [customerId],
  );
  const customer = customerResult.rows[0];
  if (!customer) return undefined;

  const [destinationCounterparties, useCaseGateDecisions, kycDocuments] = await Promise.all([
    listCustomerDestinationCounterparties(customerId),
    listCustomerUseCaseGateDecisions(customerId),
    getPool().query<{
      id: string; documentType: string; storageKey: string; storageUrl: string; originalFilename: string; mimeType: string; sizeBytes: string;
      reviewStatus: string; reviewNote: string | null; reviewedBy: string | null; reviewedAt: Date | null; uploadedBy: string; uploadedAt: Date;
    }>(
      `SELECT id, document_type AS "documentType", storage_key AS "storageKey", storage_url AS "storageUrl", original_filename AS "originalFilename", mime_type AS "mimeType", size_bytes::text AS "sizeBytes", review_status AS "reviewStatus", review_note AS "reviewNote", reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt", uploaded_by AS "uploadedBy", uploaded_at AS "uploadedAt"
         FROM kyc_documents WHERE customer_id=$1 ORDER BY uploaded_at DESC`,
      [customerId],
    ).then(result => result.rows),
  ]);

  const documentIds = kycDocuments.map(document => document.id);

  const [linkedAnalysisJobs, activity] = await Promise.all([
    documentIds.length === 0
      ? Promise.resolve([])
      : getPool().query<{
          id: string; kycDocumentId: string | null; caseKind: string; documentClass: string; state: string; submittedBy: string; submittedAt: Date; completedAt: Date | null;
        }>(
          `SELECT id, kyc_document_id AS "kycDocumentId", case_kind AS "caseKind", document_class AS "documentClass", state, submitted_by AS "submittedBy", submitted_at AS "submittedAt", completed_at AS "completedAt"
             FROM document_analysis_jobs WHERE kyc_document_id = ANY($1::uuid[]) ORDER BY submitted_at DESC`,
          [documentIds],
        ).then(result => result.rows),
    listPostgresActivityEventsForObjects([customerId, ...documentIds]),
  ]);

  const analysisJobIds = linkedAnalysisJobs.map(job => job.id);
  const [linkedEvidence, linkedReviewerDecisions] = await Promise.all([
    analysisJobIds.length === 0
      ? Promise.resolve([])
      : getPool().query<{ id: string; analysisJobId: string; kind: string; disposition: string; createdAt: Date }>(
          `SELECT id, analysis_job_id AS "analysisJobId", kind, disposition, created_at AS "createdAt" FROM document_analysis_evidence WHERE analysis_job_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
          [analysisJobIds],
        ).then(result => result.rows),
    analysisJobIds.length === 0
      ? Promise.resolve([])
      : getPool().query<{ id: string; analysisJobId: string; disposition: string; rationale: string; decidedBy: string; decidedAt: Date }>(
          `SELECT id, analysis_job_id AS "analysisJobId", disposition, rationale, decided_by AS "decidedBy", decided_at AS "decidedAt" FROM verification_reviewer_decisions WHERE analysis_job_id = ANY($1::uuid[]) ORDER BY decided_at DESC`,
          [analysisJobIds],
        ).then(result => result.rows),
  ]);

  return {
    customer,
    destinationCounterparties,
    useCaseGateDecisions,
    kycDocuments,
    linkedAnalysisJobs,
    linkedEvidence,
    linkedReviewerDecisions,
    activity,
  };
}
