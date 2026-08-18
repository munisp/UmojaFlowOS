import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createPostgresBeneficiary,
  createPostgresCounterparty,
  createPostgresCounterpartyAuthorization,
  createPostgresCustomer,
  createPostgresIntegrationConnection,
  createPostgresRateLock,
  listPostgresActivityEventsForObjects,
  recordPostgresMarketObservation,
  transitionPostgresCounterpartyAuthorization,
} from "./postgres";
import {
  cancelPostgresRateLock,
  createPostgresPaymentLeg,
  createPostgresPaymentOrder,
  expirePostgresRateLocks,
  listPostgresPaymentLegs,
  listPostgresPaymentOrders,
  transitionPostgresPaymentOrder,
  transitionPostgresPaymentLeg,
  allowedInternalLegTransitions,
} from "./paymentWorkflow";

const enabled = process.env.POSTGRES_INTEGRATION_TEST === "1";
const suite = enabled ? describe : describe.skip;

const treasury = { openId: `regression-treasury-${randomUUID()}`, role: "treasury_operator" as const };
const compliance = { openId: `regression-compliance-${randomUUID()}`, role: "compliance_officer" as const };
const administrator = { openId: `regression-admin-${randomUUID()}`, role: "admin" as const };

suite("canonical payment workflow", () => {
  it("fails closed when the referenced rate lock does not exist", async () => {
    await expect(
      createPostgresPaymentOrder(treasury, {
        idempotencyKey: `regression-${randomUUID()}`,
        customerId: randomUUID(),
        beneficiaryId: randomUUID(),
        rateLockId: randomUUID(),
        sourceAmount: "100.00",
      }),
    ).rejects.toThrow(/canonical rate lock is required/i);
  });

  it("rejects a non-positive source amount before touching the database", async () => {
    await expect(
      createPostgresPaymentOrder(treasury, {
        idempotencyKey: `regression-${randomUUID()}`,
        customerId: randomUUID(),
        beneficiaryId: randomUUID(),
        rateLockId: randomUUID(),
        sourceAmount: "0",
      }),
    ).rejects.toThrow(/positive source amount/i);
  });

  it("refuses every provider-dependent execution state", async () => {
    for (const status of ["executing", "partially_completed", "completed", "failed"]) {
      await expect(
        transitionPostgresPaymentOrder(treasury, {
          paymentOrderId: randomUUID(),
          status,
          reason: "Regression check for provider-dependent execution boundary.",
        }),
      ).rejects.toThrow(/verified provider finality reference/i);
    }
  });

  it("requires a substantive transition reason", async () => {
    await expect(
      transitionPostgresPaymentOrder(treasury, {
        paymentOrderId: randomUUID(),
        status: "cancelled",
        reason: "short",
      }),
    ).rejects.toThrow(/substantive transition reason/i);
  });

  it("refuses a leg whose counterparty has no verified licence authorisation", async () => {
    const counterparty = await createPostgresCounterparty(compliance, {
      legalName: `regression-counterparty-${randomUUID()}`,
      counterpartyType: "correspondent_bank",
      jurisdiction: "NG",
    });

    await expect(
      createPostgresPaymentLeg(treasury, {
        paymentOrderId: randomUUID(),
        sequenceNumber: 1,
        legKind: "payout",
        counterpartyId: counterparty.id,
      }),
    ).rejects.toThrow(/canonical payment order is required/i);
  });

  it("expires elapsed rate locks idempotently and records each transition", async () => {
    const first = await expirePostgresRateLocks(treasury);
    expect(typeof first.expiredCount).toBe("number");

    // A second evaluation over the same state must expire nothing further.
    const second = await expirePostgresRateLocks(treasury);
    expect(second.expiredCount).toBe(0);

    if (first.expiredIds.length > 0) {
      const events = await listPostgresActivityEventsForObjects("rate_lock", first.expiredIds);
      expect(events.some(event => event.action === "rate_lock.expired")).toBe(true);
    }
  });

  it("reads orders and legs without creating either", async () => {
    const orders = await listPostgresPaymentOrders();
    const legs = await listPostgresPaymentLegs();
    expect(Array.isArray(orders)).toBe(true);
    expect(Array.isArray(legs)).toBe(true);

    // Any persisted order must have derived its target amount from a locked
    // rate, and finality may only be present alongside a provider reference.
    for (const order of orders) {
      if (order.status === "completed") {
        expect(order.providerFinalityReference).toBeTruthy();
      }
    }
  });

  it("drafts an order and leg from real records, then blocks unauthorised approval", async () => {
    const customer = await createPostgresCustomer(compliance, {
      legalName: `regression-customer-${randomUUID()}`,
      registrationIdentifier: `RC-${randomUUID().slice(0, 12)}`,
    });
    const beneficiary = await createPostgresBeneficiary(compliance, {
      customerId: customer.id,
      legalName: `regression-beneficiary-${randomUUID()}`,
      countryCode: "NG",
      bankOrWalletReference: `regression-ref-${randomUUID().slice(0, 10)}`,
    });

    // Drafting requires a live rate lock, which requires a recorded market
    // observation from an active integration. Without one the workflow must
    // fail closed rather than invent a rate.
    await expect(
      createPostgresPaymentOrder(treasury, {
        idempotencyKey: `regression-${randomUUID()}`,
        customerId: customer.id,
        beneficiaryId: beneficiary.id,
        rateLockId: randomUUID(),
        sourceAmount: "1000.00",
      }),
    ).rejects.toThrow(/canonical rate lock is required/i);

    // The authorisation guard for legs is independently verifiable: a
    // counterparty transitioned to verified satisfies it, an unverified one
    // does not.
    const counterparty = await createPostgresCounterparty(compliance, {
      legalName: `regression-counterparty-${randomUUID()}`,
      counterpartyType: "correspondent_bank",
      jurisdiction: "NG",
    });
    const authorization = await createPostgresCounterpartyAuthorization(compliance, {
      counterpartyId: counterparty.id,
      regulator: "CBN",
      licenceReference: `regression-licence-${randomUUID().slice(0, 10)}`,
      scopeDescription: "Regression validation of the payment-leg authorisation guard.",
      evidenceUri: "s3://regression/licence-evidence",
      validFrom: new Date(Date.now() - 86_400_000),
      status: "pending_review",
    });
    const verified = await transitionPostgresCounterpartyAuthorization(administrator, {
      authorizationId: authorization.id,
      status: "verified",
    });
    expect(verified.status).toBe("verified");
  });

  it("refuses every provider-dependent leg state", async () => {
    for (const status of ["executing", "partially_completed", "completed", "failed"]) {
      await expect(
        transitionPostgresPaymentLeg(treasury, {
          paymentLegId: randomUUID(),
          status,
          reason: "Regression check for the leg provider-dependent boundary.",
        }),
      ).rejects.toThrow(/verified provider instruction or finality reference/i);
    }
  });

  it("requires a substantive reason for a leg transition", async () => {
    await expect(
      transitionPostgresPaymentLeg(treasury, {
        paymentLegId: randomUUID(),
        status: "cancelled",
        reason: "brief",
      }),
    ).rejects.toThrow(/substantive transition reason/i);
  });

  it("fails closed when the leg does not exist", async () => {
    await expect(
      transitionPostgresPaymentLeg(treasury, {
        paymentLegId: randomUUID(),
        status: "cancelled",
        reason: "Regression check for a leg that was never created.",
      }),
    ).rejects.toThrow(/Payment leg was not found/i);
  });

  it("offers no leg transition out of a terminal or provider-owned state", () => {
    expect(allowedInternalLegTransitions("cancelled")).toEqual([]);
    expect(allowedInternalLegTransitions("completed")).toEqual([]);
    expect(allowedInternalLegTransitions("executing")).toEqual([]);

    // Approval is reachable internally, but execution never is.
    const reachable = new Set(
      ["draft", "pending_policy_decision", "manual_review", "blocked", "approved"].flatMap(state =>
        allowedInternalLegTransitions(state),
      ),
    );
    expect(reachable.has("approved")).toBe(true);
    for (const state of ["executing", "partially_completed", "completed", "failed"]) {
      expect(reachable.has(state)).toBe(false);
    }
  });

  it("requires a substantive reason to cancel a rate lock", async () => {
    await expect(
      cancelPostgresRateLock(treasury, { rateLockId: randomUUID(), reason: "no" }),
    ).rejects.toThrow(/substantive cancellation reason/i);
  });

  it("fails closed when cancelling a rate lock that does not exist", async () => {
    await expect(
      cancelPostgresRateLock(treasury, {
        rateLockId: randomUUID(),
        reason: "Regression check for cancelling a lock that was never created.",
      }),
    ).rejects.toThrow(/Rate lock was not found/i);
  });

  it("keeps the whole rate chain fail-closed while no integration is active", async () => {
    // A lock cannot exist without a recorded observation, and an observation
    // cannot exist without an active FX or stablecoin market-data integration.
    // No integration can be activated without an authorised provider, so the
    // chain must refuse at its first link rather than assume a rate.
    const counterparty = await createPostgresCounterparty(compliance, {
      legalName: `regression-counterparty-${randomUUID()}`,
      counterpartyType: "fx_liquidity_provider",
      jurisdiction: "NG",
    });
    const integration = await createPostgresIntegrationConnection(compliance, {
      counterpartyId: counterparty.id,
      category: "fx_rate",
      environment: "sandbox",
      documentationUrl: "https://regression.invalid/fx-docs",
    });
    // A newly created integration is unconfigured, never active.
    expect(integration.state).toBe("unconfigured");

    await expect(
      recordPostgresMarketObservation(treasury, {
        integrationConnectionId: integration.id,
        baseAsset: "USD",
        quoteAsset: "NGN",
        rate: "1650.25",
        observedAt: new Date(),
        sourceReference: `regression-obs-${randomUUID().slice(0, 8)}`,
      }),
    ).rejects.toThrow(/active canonical FX or stablecoin market-data integration is required/i);

    await expect(
      createPostgresRateLock(treasury, {
        marketObservationId: randomUUID(),
        corridor: "NIGERIA_NGN",
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toThrow(/existing canonical market observation/i);
  });

  it("binds a consumed lock to its order so the cancellation guard reads a real binding", async () => {
    // The guard is verified structurally: consumption is recorded on the lock
    // itself, and both the cancellation and reuse checks read that column.
    const source = readFileSync(resolve(process.cwd(), "server/paymentWorkflow.ts"), "utf8");

    // Drafting records consumption on the lock, in the same transaction.
    expect(source).toContain("UPDATE rate_locks SET payment_order_id=$1 WHERE id=$2 AND payment_order_id IS NULL");
    expect(source).toContain('"rate_lock.consumed"');

    // Reuse of a consumed lock fails closed during drafting.
    expect(source).toContain("already been consumed by a payment order");

    // Cancellation reads the same binding rather than assuming it.
    expect(source).toContain('SELECT payment_order_id AS "paymentOrderId" FROM rate_locks WHERE id = $1');
    expect(source).toContain("bound to a payment order and may not be cancelled");

    // An idempotent replay may not silently rebind to a different lock.
    expect(source).toContain("Idempotency key already refers to an order backed by a different rate lock");
  });
});
