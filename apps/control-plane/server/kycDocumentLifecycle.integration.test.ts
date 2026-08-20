import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPool, createPostgresCustomer, createPostgresKycDocumentUploadIntent, describePostgresTableColumns, finalizePostgresKycDocumentUpload, listPostgresActivityEventsForObjects, listPostgresKycDocuments, updatePostgresKycDocumentReview } from "./postgres";

const runIntegration = process.env.POSTGRES_INTEGRATION_TEST === "1"
  && Boolean(process.env.UMOJA_OBJECT_STORAGE_BUCKET)
  && Boolean(process.env.UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID)
  && Boolean(process.env.UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY);
const officer = { openId: `kyc-lifecycle-${Date.now()}`, role: "compliance_officer" as const };

/**
 * The document bytes below are a synthetic regression fixture, not customer
 * data. They travel only through the real presigned-upload path so the checksum
 * and metadata verification in `finalizePostgresKycDocumentUpload` is genuinely
 * exercised, and PostgreSQL still stores nothing but a storage reference.
 */
async function ingestVerifiedDocument() {
  const customer = await createPostgresCustomer(officer, {
    legalName: `Lifecycle Counterparty ${Date.now()}`,
    registrationIdentifier: `RC-LIFECYCLE-${Date.now()}`,
  });
  const bytes = Buffer.from(`%PDF-1.7\n% UmojaFlowOS lifecycle regression fixture ${Date.now()}\n`, "utf8");
  const intent = await createPostgresKycDocumentUploadIntent(officer, {
    customerId: customer.id,
    documentType: "identity_document",
    originalFilename: "lifecycle-fixture.pdf",
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: bytes });
  if (!upload.ok) throw new Error(`presigned upload failed with status ${upload.status}`);
  return { customerId: customer.id, document: await finalizePostgresKycDocumentUpload(officer, intent.id) };
}

describe.skipIf(!runIntegration)("canonical KYC document lifecycle", () => {
  afterAll(async () => {
    await closePostgresPool();
  });

  it("keeps KYC document records byte-free with storage references only", async () => {
    const columns = await describePostgresTableColumns("kyc_documents");

    expect(columns.length).toBeGreaterThan(0);
    expect(columns.some(column => ["bytea", "blob"].includes(column.dataType.toLowerCase()))).toBe(false);
    expect(columns.map(column => column.columnName)).toContain("storage_key");
    expect(columns.map(column => column.columnName)).toContain("storage_url");
  });

  it("keeps upload intents byte-free and checksum-bound", async () => {
    const columns = await describePostgresTableColumns("kyc_document_upload_intents");

    expect(columns.some(column => ["bytea", "blob"].includes(column.dataType.toLowerCase()))).toBe(false);
    expect(columns.map(column => column.columnName)).toContain("content_sha256");
    expect(columns.map(column => column.columnName)).toContain("storage_key");
  });

  it("refuses to create an upload intent without a canonical customer record", async () => {
    await expect(
      createPostgresKycDocumentUploadIntent(officer, {
        customerId: "00000000-0000-4000-8000-000000000000",
        documentType: "identity_document",
        originalFilename: "identity-document.pdf",
        mimeType: "application/pdf",
        sizeBytes: 20480,
        contentSha256: "a".repeat(64),
      }),
    ).rejects.toThrow(/existing canonical customer record/);
  });

  it("rejects a finalisation whose declared checksum does not match the uploaded object", async () => {
    const customer = await createPostgresCustomer(officer, {
      legalName: `Checksum Guard Counterparty ${Date.now()}`,
      registrationIdentifier: `RC-CHECKSUM-${Date.now()}`,
    });
    const bytes = Buffer.from(`%PDF-1.7\n% checksum guard ${Date.now()}\n`, "utf8");
    const intent = await createPostgresKycDocumentUploadIntent(officer, {
      customerId: customer.id,
      documentType: "identity_document",
      originalFilename: "checksum-guard.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      contentSha256: createHash("sha256").update(Buffer.concat([bytes, Buffer.from("divergent")])).digest("hex"),
    });
    const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: bytes });
    expect(upload.ok).toBe(true);

    await expect(finalizePostgresKycDocumentUpload(officer, intent.id)).rejects.toThrow(/checksum does not match/);
    expect((await listPostgresKycDocuments()).some(record => record.customerId === customer.id)).toBe(false);
  });

  it("moves a verified document through every allowed review state and refuses terminal reopening", async () => {
    const { document } = await ingestVerifiedDocument();
    expect(document.reviewStatus).toBe("submitted");

    for (const [state, note] of [
      ["under_review", "Compliance officer opened manual review of the submitted identity document."],
      ["approved", "Manual review completed against the authorised source document; no automated disposition was used."],
      ["expired", "Document validity period elapsed, so refreshed evidence is required."],
    ] as const) {
      const result = await updatePostgresKycDocumentReview(officer, { documentId: document.id, reviewStatus: state, reviewNote: note });
      expect(result.reviewStatus).toBe(state);
    }

    await expect(
      updatePostgresKycDocumentReview(officer, {
        documentId: document.id,
        reviewStatus: "under_review",
        reviewNote: "Attempting to reopen an expired document must fail closed.",
      }),
    ).rejects.toThrow(/invalid KYC document review lifecycle transition/);

    const events = await listPostgresActivityEventsForObjects([document.id]);
    const transitions = events.filter(event => event.action === "kyc_document.review_transitioned").map(event => event.metadata as { from: string; to: string; documentBytesPersisted: boolean });
    expect(transitions.map(entry => `${entry.from}->${entry.to}`)).toEqual(["submitted->under_review", "under_review->approved", "approved->expired"]);
    expect(transitions.every(entry => entry.documentBytesPersisted === false)).toBe(true);
    expect(events.some(event => event.action === "kyc_document.upload_verified_and_recorded")).toBe(true);
  });

  it("refuses a rejected document from re-entering review", async () => {
    const { document } = await ingestVerifiedDocument();

    await updatePostgresKycDocumentReview(officer, {
      documentId: document.id,
      reviewStatus: "under_review",
      reviewNote: "Manual review opened before rejection.",
    });
    const rejected = await updatePostgresKycDocumentReview(officer, {
      documentId: document.id,
      reviewStatus: "rejected",
      reviewNote: "Document did not satisfy the corridor onboarding evidence requirements.",
    });
    expect(rejected.reviewStatus).toBe("rejected");

    await expect(
      updatePostgresKycDocumentReview(officer, {
        documentId: document.id,
        reviewStatus: "under_review",
        reviewNote: "Rejected documents must require a fresh submission.",
      }),
    ).rejects.toThrow(/invalid KYC document review lifecycle transition/);
  });
});
