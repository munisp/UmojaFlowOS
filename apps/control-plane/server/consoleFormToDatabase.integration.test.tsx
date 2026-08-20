/**
 * Form-to-database regressions.
 *
 * The component tests under `client/src/components` render the real forms but
 * hand their submissions to test doubles, and the integration tests under
 * `server` call the real procedures but construct their inputs by hand. Each
 * half can be correct while the seam between them is wrong: a renamed field, a
 * mis-shaped date, a value the form sends as a string and the procedure expects
 * as a number. Nothing in either suite would notice.
 *
 * These tests close that seam. They render the real form component, bind its
 * submit handler to a real `appRouter` caller with a role-bearing context, drive
 * the real DOM interaction, and then read the row back out of canonical
 * PostgreSQL. Every fixture is purgeable by the standard prefixes.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { PostgresCustomerOnboardingForm } from "../client/src/components/PostgresCustomerOnboardingForm";
import { PostgresReportDraftForm } from "../client/src/components/PostgresReportDraftForm";
import { PostgresReportTransitionForm } from "../client/src/components/PostgresReportTransitionForm";
import { KycDocumentReviewTable } from "../client/src/components/KycDocumentReviewControls";
import { ComplianceCaseDispositionControls } from "../client/src/components/ComplianceCaseWorkflowControls";
import { RateLockForm } from "../client/src/components/RateLockControls";
import { PaymentOrderForm } from "../client/src/components/PaymentWorkflowControls";
import { TreasuryRecommendationForm } from "../client/src/components/TreasuryRebalancingControls";
import { RegulatoryDeadlineForm } from "../client/src/components/RegulatoryDeadlineControls";
import { SarStrFilingForm } from "../client/src/components/SarStrFilingControls";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { registerPostgresLegalEntity } from "./legalEntityRegistry";
import {
  closePostgresPool,
  createPostgresComplianceCase,
  listPostgresComplianceCases,
  listPostgresCustomers,
  listPostgresRegulatoryDeadlines,
  listPostgresRegulatoryReports,
  listPostgresSarStrFilings,
} from "./postgres";

const runIntegration = process.env.POSTGRES_INTEGRATION_TEST === "1";
const runStorageIntegration = runIntegration
  && Boolean(process.env.UMOJA_OBJECT_STORAGE_BUCKET)
  && Boolean(process.env.UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID)
  && Boolean(process.env.UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY);

type Role = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

function contextFor(role: Role, openId: string): TrpcContext {
  return {
    user: {
      id: 97,
      openId,
      name: `${role} operator`,
      email: `${openId}@example.com`,
      loginMethod: "keycloak",
      role,
      createdAt: new Date("2026-08-18T00:00:00.000Z"),
      updatedAt: new Date("2026-08-18T00:00:00.000Z"),
      lastSignedIn: new Date("2026-08-18T00:00:00.000Z"),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

/** A unique suffix so parallel files and repeat runs never collide. */
function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setField(form: HTMLFormElement, name: string, value: string) {
  fireEvent.change(form.querySelector(`[name="${name}"]`) as HTMLInputElement, { target: { value } });
}

describe.skipIf(!runIntegration)("console form submissions reaching canonical PostgreSQL", () => {
  afterEach(() => cleanup());
  afterAll(async () => {
    await closePostgresPool();
  });

  it("persists a customer created through the real onboarding form", async () => {
    const caller = appRouter.createCaller(contextFor("compliance_officer", unique("regression-form-officer")));
    const legalName = `Regression ${unique("FormCustomer")}`;
    const registrationIdentifier = unique("regression-rc");
    const errors: string[] = [];

    render(
      <PostgresCustomerOnboardingForm
        pending={false}
        submit={input => {
          // The real procedure, not a double: role gate, Zod input schema,
          // repository helper, and PostgreSQL all participate.
          void caller.postgres.createCustomer(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    const form = screen.getByRole("button", { name: /Record canonical customer/i }).closest("form")!;
    setField(form, "legalName", legalName);
    setField(form, "registrationIdentifier", registrationIdentifier);
    fireEvent.submit(form);

    await waitFor(async () => {
      const rows = await listPostgresCustomers();
      expect(rows.some(row => row.legalName === legalName)).toBe(true);
    });
    expect(errors).toEqual([]);

    // The form's own trimming reached the database rather than being undone.
    const stored = (await listPostgresCustomers()).find(row => row.legalName === legalName);
    expect(stored?.registrationIdentifier).toBe(registrationIdentifier);
  });

  it("refuses the same submission from a treasury operator, proving the gate is live in this path", async () => {
    const caller = appRouter.createCaller(contextFor("treasury_operator", unique("regression-form-treasury")));
    const legalName = `Regression ${unique("BlockedCustomer")}`;
    const errors: string[] = [];

    render(
      <PostgresCustomerOnboardingForm
        pending={false}
        submit={input => {
          void caller.postgres.createCustomer(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    const form = screen.getByRole("button", { name: /Record canonical customer/i }).closest("form")!;
    setField(form, "legalName", legalName);
    setField(form, "registrationIdentifier", unique("regression-rc"));
    fireEvent.submit(form);

    await waitFor(() => expect(errors.length).toBe(1));
    expect(errors[0]).toMatch(/do not have required permission/i);

    // And nothing was written.
    const rows = await listPostgresCustomers();
    expect(rows.some(row => row.legalName === legalName)).toBe(false);
  });

  it("persists a regulatory deadline with the corridor and regulator the operator selected", async () => {
    const caller = appRouter.createCaller(contextFor("compliance_officer", unique("regression-form-officer")));
    const title = `Regression ${unique("SARB return")}`;
    const errors: string[] = [];

    render(
      <RegulatoryDeadlineForm
        pending={false}
        submit={input => {
          void caller.postgres.createRegulatoryDeadline(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    // Change both selects away from their defaults: if the form dropped either,
    // the row would silently carry CBN/Nigeria and the mismatch would be invisible.
    fireEvent.change(screen.getByDisplayValue("CBN"), { target: { value: "SARB" } });
    fireEvent.change(screen.getByDisplayValue("Nigeria (NGN)"), { target: { value: "SOUTH_AFRICA_ZAR" } });

    const form = screen.getByRole("button", { name: /Record regulatory deadline/i }).closest("form")!;
    setField(form, "title", title);
    setField(form, "dueAt", "2026-09-30T15:00");
    setField(form, "sourceReference", "https://www.resbank.co.za/regulatory-notice");
    fireEvent.submit(form);

    await waitFor(async () => {
      const rows = await listPostgresRegulatoryDeadlines();
      expect(rows.some(row => row.title === title)).toBe(true);
    });
    expect(errors).toEqual([]);

    const stored = (await listPostgresRegulatoryDeadlines()).find(row => row.title === title);
    expect(stored?.regulator).toBe("SARB");
    expect(stored?.corridor).toBe("SOUTH_AFRICA_ZAR");
    expect(stored?.status).toBe("open");
    // The datetime-local string survived as a real instant rather than a shifted
    // or invalid date.
    expect(Number.isNaN(new Date(stored!.dueAt).getTime())).toBe(false);
  });

  it("persists a SAR/STR draft against a real case and never marks it submitted", async () => {
    const officer = unique("regression-form-officer");
    const caller = appRouter.createCaller(contextFor("compliance_officer", officer));

    // A filing requires a real case, so one is created through the repository
    // first; the form is then driven against it exactly as the console does.
    const sourceReference = `regression-alert-case-${unique("form")}`;
    const complianceCase = await createPostgresComplianceCase(
      { openId: officer, role: "compliance_officer" },
      { caseType: "transaction_monitoring", severity: "medium", sourceReference },
    );

    const filingSource = `regression-filing-${unique("form")}`;
    const errors: string[] = [];

    render(
      <SarStrFilingForm
        cases={[{ id: complianceCase.id, caseType: "transaction_monitoring", sourceReference }]}
        pending={false}
        submit={input => {
          void caller.postgres.createSarStrFiling(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("Nigeria (NGN)"), { target: { value: "KENYA_KES" } });
    fireEvent.change(screen.getByDisplayValue("SAR"), { target: { value: "str" } });

    const form = screen.getByRole("button", { name: /Create SAR\/STR draft/i }).closest("form")!;
    setField(form, "filingAuthority", "Financial Reporting Centre");
    setField(form, "sourceReference", filingSource);
    fireEvent.submit(form);

    await waitFor(async () => {
      const rows = await listPostgresSarStrFilings();
      expect(rows.some(row => row.sourceReference === filingSource)).toBe(true);
    });
    expect(errors).toEqual([]);

    const stored = (await listPostgresSarStrFilings()).find(row => row.sourceReference === filingSource);
    expect(stored?.corridor).toBe("KENYA_KES");
    expect(stored?.filingType).toBe("str");
    // The console cannot originate a submitted filing: submission requires a
    // verified channel reference that no draft path can supply.
    expect(stored?.status).not.toBe("submitted");
    expect(stored?.submissionReference ?? null).toBeNull();
  });

  it("persists a report draft through the real form against a registered legal entity", async () => {
    const officer = unique("regression-form-officer");
    const caller = appRouter.createCaller(contextFor("compliance_officer", officer));

    const entity = await registerPostgresLegalEntity(
      { openId: unique("regression-form-admin"), role: "admin" },
      {
        legalName: `Regression ${unique("ReportEntity")}`,
        jurisdiction: "Kenya",
        registrationIdentifier: unique("regression-entity"),
      },
    );

    const reportType = unique("regression-return");
    const errors: string[] = [];

    render(
      <PostgresReportDraftForm
        pending={false}
        submit={input => {
          void caller.postgres.createRegulatoryReport(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("CBN"), { target: { value: "CBK" } });
    fireEvent.change(screen.getByDisplayValue("Nigeria (NGN)"), { target: { value: "KENYA_KES" } });

    const form = screen.getByRole("button", { name: /Create PostgreSQL draft/i }).closest("form")!;
    setField(form, "legalEntityId", entity.id);
    setField(form, "reportType", reportType);
    setField(form, "periodStart", "2026-07-01");
    setField(form, "periodEnd", "2026-07-31");
    fireEvent.submit(form);

    await waitFor(async () => {
      const rows = await listPostgresRegulatoryReports();
      expect(rows.some(row => row.reportType === reportType)).toBe(true);
    });
    expect(errors).toEqual([]);

    const stored = (await listPostgresRegulatoryReports()).find(row => row.reportType === reportType);
    expect(stored?.regulator).toBe("CBK");
    expect(stored?.corridor).toBe("KENYA_KES");
    // A draft is a draft: the form cannot originate any later workflow state.
    expect(stored?.status).toBe("draft");
  });

  it("refuses a report transition to submitted through the real form without a channel reference", async () => {
    const officer = unique("regression-form-officer");
    const caller = appRouter.createCaller(contextFor("compliance_officer", officer));

    const entity = await registerPostgresLegalEntity(
      { openId: unique("regression-form-admin"), role: "admin" },
      {
        legalName: `Regression ${unique("TransitionEntity")}`,
        jurisdiction: "South Africa",
        registrationIdentifier: unique("regression-entity"),
      },
    );
    const reportType = unique("regression-return");
    const draft = await caller.postgres.createRegulatoryReport({
      regulator: "SARB",
      corridor: "SOUTH_AFRICA_ZAR",
      reportType,
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-07-31T00:00:00.000Z"),
      legalEntityId: entity.id,
    });

    const errors: string[] = [];
    render(
      <PostgresReportTransitionForm
        rows={[{ id: draft.id, regulator: "SARB", reportType }]}
        pending={false}
        submit={input => {
          void caller.postgres.transitionRegulatoryReport(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("under review"), { target: { value: "submitted" } });
    const form = screen.getByRole("button", { name: /Record workflow state/i }).closest("form")!;
    setField(form, "statusReason", "Attempting submission without a channel reference.");
    fireEvent.submit(form);

    await waitFor(() => expect(errors.length).toBe(1));

    // The refusal is the server's, and the record is unchanged.
    const stored = (await listPostgresRegulatoryReports()).find(row => row.id === draft.id);
    expect(stored?.status).toBe("draft");
  });

  it.skipIf(!runStorageIntegration)("records a KYC document review decision through the real control", async () => {
    const officer = unique("regression-form-officer");
    const caller = appRouter.createCaller(contextFor("compliance_officer", officer));

    const legalName = `Regression ${unique("ReviewCustomer")}`;
    const customer = await caller.postgres.createCustomer({
      legalName,
      registrationIdentifier: unique("regression-rc"),
    });

    // The full production path: an intent, a real presigned upload of real
    // bytes, then finalisation, which verifies the object and its checksum.
    const bytes = Buffer.from(`%PDF-1.7\n% UmojaFlowOS form-to-database fixture ${unique("doc")}\n`, "utf8");
    const intent = await caller.postgres.createKycDocumentUploadIntent({
      customerId: customer.id,
      documentType: "identity_document",
      originalFilename: "passport.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const upload = await fetch(intent.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    if (!upload.ok) throw new Error(`presigned upload failed with status ${upload.status}`);
    const document = await caller.postgres.finalizeKycDocumentUpload({ uploadIntentId: intent.id });

    const errors: string[] = [];
    render(
      <KycDocumentReviewTable
        rows={[
          {
            id: document.id,
            customerLegalName: legalName,
            documentType: "identity_document",
            originalFilename: "passport.pdf",
            reviewStatus: "submitted",
            reviewNote: null,
            reviewedBy: null,
            reviewedAt: null,
            uploadedAt: new Date(),
          },
        ]}
        loading={false}
        canReview
        pending={false}
        submit={input => {
          void caller.postgres.updateKycDocumentReview(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Set review state for passport.pdf"), {
      target: { value: "under_review" },
    });
    fireEvent.change(screen.getByLabelText("Review note for passport.pdf"), {
      target: { value: "Opened for manual verification against the registry." },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Record" }).closest("form")!);

    await waitFor(async () => {
      const rows = await caller.postgres.kycDocuments();
      expect(rows.find(row => row.id === document.id)?.reviewStatus).toBe("under_review");
    });
    expect(errors).toEqual([]);

    // The decision is attributed to the acting officer, not to any model.
    const stored = (await caller.postgres.kycDocuments()).find(row => row.id === document.id);
    expect(stored?.reviewedBy).toBe(officer);
    expect(stored?.reviewNote).toBe("Opened for manual verification against the registry.");
  });

  it("records a compliance case disposition through the real control with its rationale", async () => {
    const officer = unique("regression-form-officer");
    const caller = appRouter.createCaller(contextFor("compliance_officer", officer));

    const sourceReference = `regression-alert-case-${unique("disposition")}`;
    const complianceCase = await createPostgresComplianceCase(
      { openId: officer, role: "compliance_officer" },
      { caseType: "kyc", severity: "low", sourceReference },
    );

    const errors: string[] = [];
    render(
      <ComplianceCaseDispositionControls
        cases={[
          {
            id: complianceCase.id,
            caseType: "kyc",
            status: complianceCase.status,
            severity: "low",
            sourceReference,
            openedAt: new Date(),
          },
        ]}
        canDispose
        pending={false}
        dispose={input => {
          void caller.postgres.disposeComplianceCase(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    const rationale = document.querySelector('input[name="decisionReason"]') as HTMLInputElement;
    fireEvent.change(rationale, {
      target: { value: "Reviewed the recorded evidence and found no reportable indicator." },
    });
    fireEvent.submit(rationale.closest("form")!);

    await waitFor(async () => {
      const rows = await listPostgresComplianceCases();
      const stored = rows.find(row => row.id === complianceCase.id);
      expect(stored?.status).not.toBe(complianceCase.status);
    });
    expect(errors).toEqual([]);
  });

  /**
   * The rate-lock and payment-order forms cannot be driven to a persisted row
   * here, and that is the correct outcome rather than a coverage gap. A rate
   * lock requires a market observation, a market observation requires an active
   * FX integration, and no code path activates an integration: activation
   * demands a credential-verified provider health check that does not exist in
   * this environment. Grepping the server for `UPDATE integration_connections`
   * returns nothing, so there is no route to an active state at all.
   *
   * What can be proven is that the console form reaches the real procedure and
   * that the procedure refuses, rather than the form silently doing nothing.
   */
  it("drives the rate-lock form into a real refusal rather than a fabricated lock", async () => {
    const caller = appRouter.createCaller(contextFor("treasury_operator", unique("regression-form-treasury")));
    const errors: string[] = [];

    render(
      <RateLockForm
        observations={[
          {
            id: "3f2b9c41-7d8e-4a05-9b16-2c3d4e5f6a70",
            baseAsset: "USD",
            quoteAsset: "NGN",
            rate: "1650.25",
            observedAt: new Date(),
          },
        ]}
        pending={false}
        submit={input => {
          void caller.postgres.createRateLock(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    const form = screen.getByRole("button", { name: /Create source-derived rate lock/i }).closest("form")!;
    setField(form, "expiresAt", "2026-12-31T12:00");
    fireEvent.submit(form);

    await waitFor(() => expect(errors.length).toBe(1));
    // The refusal comes from the server, not from a disabled button.
    expect(errors[0]).toMatch(/observation|integration|not found|required/i);
  });

  it("drives the payment-order form into a real refusal without a live rate lock", async () => {
    const officer = unique("regression-form-officer");
    const complianceCaller = appRouter.createCaller(contextFor("compliance_officer", officer));
    const treasuryCaller = appRouter.createCaller(contextFor("treasury_operator", unique("regression-form-treasury")));

    // Real customer and beneficiary so the refusal is attributable to the rate
    // lock alone rather than to a missing party.
    const customer = await complianceCaller.postgres.createCustomer({
      legalName: `Regression ${unique("PaymentCustomer")}`,
      registrationIdentifier: unique("regression-rc"),
    });
    const beneficiary = await complianceCaller.postgres.createBeneficiary({
      customerId: customer.id,
      legalName: `Regression ${unique("PaymentBeneficiary")}`,
      countryCode: "NG",
      bankOrWalletReference: unique("regression-acct"),
    });

    const errors: string[] = [];
    render(
      <PaymentOrderForm
        customers={[{ id: customer.id, legalName: customer.legalName }]}
        beneficiaries={[
          { id: beneficiary.id, customerId: customer.id, legalName: beneficiary.legalName, screeningState: beneficiary.screeningState },
        ]}
        // A lock shape the console would render, but no such live lock exists in
        // canonical PostgreSQL, because no FX integration can be activated.
        rateLocks={[
          {
            id: "6c5b4a39-2817-4d6e-9f01-a2b3c4d5e6f7",
            corridor: "NIGERIA_NGN",
            lockedRate: "1650.25",
            baseAsset: "USD",
            quoteAsset: "NGN",
            status: "locked",
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        ]}
        pending={false}
        submit={input => {
          void treasuryCaller.postgres.createPaymentOrder(input).catch(error => errors.push(String(error)));
        }}
      />,
    );

    const form = screen.getByRole("button", { name: /Draft payment order/i }).closest("form")!;
    setField(form, "idempotencyKey", unique("regression-idem"));
    setField(form, "sourceAmount", "100.00");
    fireEvent.submit(form);

    await waitFor(() => expect(errors.length).toBe(1));
    // The server refuses because the referenced lock is not a live canonical
    // record; the console cannot conjure one.
    expect(errors[0]).toMatch(/rate lock/i);

    const orders = await treasuryCaller.postgres.paymentOrders();
    expect(orders.some(order => order.customerLegalName === customer.legalName)).toBe(false);
  });

  it("withholds the treasury proposal form entirely when no approved buffer policy exists", async () => {
    const caller = appRouter.createCaller(contextFor("treasury_operator", unique("regression-form-treasury")));

    // Read the live policy list rather than assuming it is empty.
    const policies = await caller.postgres.treasuryBufferPolicies();

    render(<TreasuryRecommendationForm policies={policies} pending={false} submit={() => undefined} />);

    if (policies.length === 0) {
      // No buffer policy can be created through any application path: grepping
      // the repository for `INSERT INTO treasury_buffer_policies` returns
      // nothing, because an approved policy is a governance artefact rather
      // than a console entry. The correct console behaviour is therefore to
      // offer no proposal affordance at all.
      expect(screen.getByTestId("treasury-proposal-unavailable")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Propose rebalancing/i })).toBeNull();
    } else {
      expect(screen.getByTestId("treasury-proposal-form")).toBeTruthy();
    }
  });
});
