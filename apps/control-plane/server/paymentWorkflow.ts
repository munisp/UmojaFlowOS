/**
 * Canonical PostgreSQL payment-order, payment-leg, and rate-lock lifecycle
 * workflow.
 *
 * Two boundaries are enforced here and proven by regression:
 *
 * 1. Nothing in this module contacts a payment provider. A draft order and its
 *    legs are internal records only. Any status beyond internal preparation
 *    requires a verified provider reference, which is unavailable until an
 *    authorised provider is connected, so those transitions fail closed.
 * 2. No rate, amount, or balance is invented. An order requires a live rate
 *    lock derived from a recorded market observation, and the target amount is
 *    computed from that locked rate rather than supplied by the caller.
 */
import { Pool, type PoolClient } from "pg";
import { registerTestResource } from "./testResourceRegistry";

let pool: Pool | undefined;

function getPool() {
  if (!pool) {
    pool = registerTestResource(
      process.env.POSTGRES_DATABASE_URL
        ? new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL })
        : new Pool({
            host: "/var/run/postgresql",
            database: process.env.POSTGRES_TEST_DATABASE ?? "umoja_test",
            user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
          }),
    );
  }
  return pool;
}

export type WorkflowActor = {
  openId: string;
  role: "admin" | "compliance_officer" | "treasury_operator" | "auditor";
};

type Client = PoolClient;

/**
 * A beneficiary may enter a payment workflow only after a current screening
 * decision explicitly clears it.  Every other persisted state means a control
 * is incomplete, unavailable, or adverse and must stop before any rate lock is
 * consumed.
 */
export function assertBeneficiaryScreeningClear(screeningState: string): void {
  if (screeningState !== "clear") {
    throw new Error(
      `Beneficiary screening must be clear before drafting a payment order; current state is ${screeningState}`,
    );
  }
}

async function recordEvent(
  client: Client,
  actor: WorkflowActor,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify({ ...metadata, source: "postgres-control-plane" })],
  );
}

/**
 * Expire every rate lock whose expiry has passed. This is idempotent: a second
 * run over the same locks changes nothing because only `locked` rows are
 * selected. Each expiry writes its own immutable event so the transition is
 * attributable to the evaluating actor and instant.
 */
export async function expirePostgresRateLocks(actor: WorkflowActor) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; expiresAt: Date }>(
      `UPDATE rate_locks
          SET status = 'expired'
        WHERE status = 'locked' AND expires_at <= now()
        RETURNING id, expires_at AS "expiresAt"`,
    );
    for (const row of rows) {
      await recordEvent(client, actor, "rate_lock.expired", "rate_lock", row.id, {
        from: "locked",
        to: "expired",
        expiresAt: row.expiresAt.toISOString(),
        reason: "expiry_elapsed",
      });
    }
    await client.query("COMMIT");
    return { expiredCount: rows.length, expiredIds: rows.map(row => row.id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Cancel a live rate lock before it elapses.
 *
 * Cancellation is deliberately narrower than expiry: a lock already consumed by
 * a payment order cannot be cancelled, because the order's derived target
 * amount depends on it. The reason is mandatory and carried on the immutable
 * event, since there is no mutable cancellation column on the lock itself.
 */
export async function cancelPostgresRateLock(
  actor: WorkflowActor,
  input: { rateLockId: string; reason: string },
) {
  if (input.reason.trim().length < 10) {
    throw new Error("A substantive cancellation reason is required");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string; expiresAt: Date }>(
      `SELECT status::text AS status, expires_at AS "expiresAt"
         FROM rate_locks WHERE id = $1 FOR UPDATE`,
      [input.rateLockId],
    );
    const lock = current.rows[0];
    if (!lock) throw new Error("Rate lock was not found");
    if (lock.status !== "locked") {
      throw new Error(`Only a live rate lock may be cancelled; this lock is ${lock.status}`);
    }

    // A lock consumed by an order cannot be cancelled: the order's derived
    // target amount depends on it. Consumption is recorded on the lock itself
    // when the order is drafted, so this guard reads a real binding.
    const consuming = await client.query<{ paymentOrderId: string | null }>(
      `SELECT payment_order_id AS "paymentOrderId" FROM rate_locks WHERE id = $1`,
      [input.rateLockId],
    );
    if (consuming.rows[0]?.paymentOrderId) {
      throw new Error("Rate lock is bound to a payment order and may not be cancelled");
    }

    const updated = await client.query<{ id: string; status: string }>(
      "UPDATE rate_locks SET status='cancelled' WHERE id=$1 RETURNING id, status::text AS status",
      [input.rateLockId],
    );
    const result = updated.rows[0];
    if (!result) throw new Error("Rate lock update did not return a record");

    await recordEvent(client, actor, "rate_lock.cancelled", "rate_lock", result.id, {
      from: "locked",
      to: "cancelled",
      expiresAt: lock.expiresAt.toISOString(),
      reason: input.reason,
    });

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listPostgresPaymentOrders() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      idempotencyKey: string;
      corridor: string;
      customerLegalName: string;
      beneficiaryLegalName: string;
      sourceCurrency: string;
      sourceAmount: string;
      targetCurrency: string;
      targetAmount: string | null;
      status: string;
      providerFinalityReference: string | null;
      createdBy: string;
      createdAt: Date;
    }>(
      `SELECT o.id, o.idempotency_key AS "idempotencyKey", o.corridor::text AS corridor,
              c.legal_name AS "customerLegalName", b.legal_name AS "beneficiaryLegalName",
              o.source_currency AS "sourceCurrency", o.source_amount::text AS "sourceAmount",
              o.target_currency AS "targetCurrency", o.target_amount::text AS "targetAmount",
              o.status::text AS status,
              o.provider_finality_reference AS "providerFinalityReference",
              o.created_by AS "createdBy", o.created_at AS "createdAt"
         FROM payment_orders o
         JOIN customers c ON c.id = o.customer_id
         JOIN beneficiaries b ON b.id = o.beneficiary_id
        ORDER BY o.created_at DESC
        LIMIT 200`,
    );
    return rows;
  } finally {
    client.release();
  }
}

export async function listPostgresPaymentLegs(paymentOrderId?: string) {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      id: string;
      paymentOrderId: string;
      sequenceNumber: number;
      legKind: string;
      counterpartyLegalName: string | null;
      status: string;
      providerInstructionReference: string | null;
      providerFinalityReference: string | null;
    }>(
      `SELECT l.id, l.payment_order_id AS "paymentOrderId", l.sequence_number AS "sequenceNumber",
              l.leg_kind AS "legKind", cp.legal_name AS "counterpartyLegalName",
              l.status::text AS status,
              l.provider_instruction_reference AS "providerInstructionReference",
              l.provider_finality_reference AS "providerFinalityReference"
         FROM payment_legs l
         LEFT JOIN counterparties cp ON cp.id = l.counterparty_id
        ${paymentOrderId ? "WHERE l.payment_order_id = $1" : ""}
        ORDER BY l.payment_order_id, l.sequence_number`,
      paymentOrderId ? [paymentOrderId] : [],
    );
    return rows;
  } finally {
    client.release();
  }
}

/**
 * Create a draft payment order from an authorised customer, beneficiary, and a
 * currently locked rate. The target amount is derived from the locked rate; no
 * caller-supplied rate or target amount is accepted. The order is created in
 * `draft` and no provider is contacted.
 */
export async function createPostgresPaymentOrder(
  actor: WorkflowActor,
  input: {
    idempotencyKey: string;
    customerId: string;
    beneficiaryId: string;
    rateLockId: string;
    sourceAmount: string;
  },
) {
  if (!/^\d+(\.\d{1,12})?$/.test(input.sourceAmount) || input.sourceAmount === "0") {
    throw new Error("A positive source amount is required");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const lockResult = await client.query<{
      id: string;
      corridor: string;
      baseAsset: string;
      quoteAsset: string;
      lockedRate: string;
      status: string;
      expiresAt: Date;
      paymentOrderId: string | null;
    }>(
      `SELECT id, corridor::text AS corridor, base_asset AS "baseAsset", quote_asset AS "quoteAsset",
              locked_rate::text AS "lockedRate", status::text AS status, expires_at AS "expiresAt",
              payment_order_id AS "paymentOrderId"
         FROM rate_locks WHERE id = $1 FOR UPDATE`,
      [input.rateLockId],
    );
    const lock = lockResult.rows[0];
    if (!lock) throw new Error("A canonical rate lock is required before drafting a payment order");
    if (lock.status !== "locked") throw new Error("Rate lock is not live; payment drafting fails closed");
    if (lock.expiresAt <= new Date()) throw new Error("Rate lock has expired; payment drafting fails closed");
    // A lock may back exactly one order. Reusing it would let two orders claim
    // the same locked rate, so reuse fails closed.
    if (lock.paymentOrderId) {
      throw new Error("Rate lock has already been consumed by a payment order; reuse fails closed");
    }

    const beneficiary = await client.query<{ id: string; customerId: string; screeningState: string }>(
      `SELECT id, customer_id AS "customerId", screening_state AS "screeningState"
         FROM beneficiaries WHERE id = $1 FOR KEY SHARE`,
      [input.beneficiaryId],
    );
    const target = beneficiary.rows[0];
    if (!target) throw new Error("A canonical beneficiary record is required");
    if (target.customerId !== input.customerId) {
      throw new Error("Beneficiary does not belong to the specified customer");
    }
    assertBeneficiaryScreeningClear(target.screeningState);

    const derived = await client.query<{ targetAmount: string }>("SELECT round($1::numeric * $2::numeric, 8)::text AS \"targetAmount\"", [input.sourceAmount, lock.lockedRate]);
    const targetAmount = derived.rows[0]?.targetAmount;
    if (!targetAmount || targetAmount === "0.00000000") throw new Error("Locked rate is unusable; payment drafting fails closed");

    const inserted = await client.query<{ id: string; status: string; targetAmount: string }>(
      `INSERT INTO payment_orders
         (idempotency_key, customer_id, beneficiary_id, corridor, source_currency, source_amount,
          target_currency, target_amount, status, created_by)
       VALUES ($1,$2,$3,$4::corridor_code,$5,$6,$7,$8,'draft',$9)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, status::text AS status, target_amount::text AS "targetAmount"`,
      [
        input.idempotencyKey,
        input.customerId,
        input.beneficiaryId,
        lock.corridor,
        lock.baseAsset,
        input.sourceAmount,
        lock.quoteAsset,
        targetAmount,
        actor.openId,
      ],
    );

    const order = inserted.rows[0];
    if (!order) {
      // Idempotent replay: the same instruction key must resolve to the same
      // order backed by the same lock. A replay presenting a different lock is
      // a different instruction wearing the same key, so it fails closed.
      const existing = await client.query<{
        id: string;
        status: string;
        targetAmount: string;
        boundLockId: string | null;
      }>(
        `SELECT o.id, o.status::text AS status, o.target_amount::text AS "targetAmount",
                (SELECT rl.id FROM rate_locks rl WHERE rl.payment_order_id = o.id LIMIT 1) AS "boundLockId"
           FROM payment_orders o WHERE o.idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const replay = existing.rows[0];
      if (!replay) throw new Error("Payment order insert did not return a record");
      if (replay.boundLockId && replay.boundLockId !== lock.id) {
        throw new Error("Idempotency key already refers to an order backed by a different rate lock");
      }
      await client.query("COMMIT");
      return { ...replay, rateLockId: lock.id, lockedRate: lock.lockedRate, idempotentReplay: true as const };
    }

    await recordEvent(client, actor, "payment_order.drafted", "payment_order", order.id, {
      rateLockId: lock.id,
      lockedRate: lock.lockedRate,
      corridor: lock.corridor,
      sourceAmount: input.sourceAmount,
      targetAmount,
      derivation: "target_amount = source_amount * locked_rate",
    });

    // Record consumption on the lock so cancellation and reuse guards read a
    // real binding rather than an assumption.
    const consumed = await client.query(
      "UPDATE rate_locks SET payment_order_id=$1 WHERE id=$2 AND payment_order_id IS NULL",
      [order.id, lock.id],
    );
    if (consumed.rowCount !== 1) {
      throw new Error("Rate lock consumption could not be recorded; payment drafting fails closed");
    }
    await recordEvent(client, actor, "rate_lock.consumed", "rate_lock", lock.id, {
      paymentOrderId: order.id,
      lockedRate: lock.lockedRate,
    });

    await client.query("COMMIT");
    return { ...order, rateLockId: lock.id, lockedRate: lock.lockedRate, idempotentReplay: false as const };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Attach a leg to a draft payment order. Legs describe the intended settlement
 * path across authorised counterparties; creating one instructs nothing.
 */
export async function createPostgresPaymentLeg(
  actor: WorkflowActor,
  input: { paymentOrderId: string; sequenceNumber: number; legKind: string; counterpartyId: string },
) {
  if (!Number.isInteger(input.sequenceNumber) || input.sequenceNumber < 1) {
    throw new Error("Leg sequence number must be a positive integer");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query<{ id: string; status: string }>(
      "SELECT id, status::text AS status FROM payment_orders WHERE id=$1 FOR UPDATE",
      [input.paymentOrderId],
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error("A canonical payment order is required before adding a leg");
    if (order.status !== "draft") throw new Error("Legs may only be added while the order is in draft");

    // A leg may only reference a counterparty with a currently verified licence
    // authorisation. Without one, the settlement path is not authorised.
    const authorised = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM counterparty_authorizations
        WHERE counterparty_id = $1
          AND status = 'verified'
          AND valid_from <= current_date
          AND (valid_to IS NULL OR valid_to >= current_date)`,
      [input.counterpartyId],
    );
    if (Number(authorised.rows[0]?.count ?? 0) === 0) {
      throw new Error("Counterparty has no currently verified licence authorisation; leg creation fails closed");
    }

    const inserted = await client.query<{ id: string; status: string; sequenceNumber: number }>(
      `INSERT INTO payment_legs (payment_order_id, sequence_number, leg_kind, counterparty_id, status)
       VALUES ($1,$2,$3,$4,'draft')
       RETURNING id, status::text AS status, sequence_number AS "sequenceNumber"`,
      [input.paymentOrderId, input.sequenceNumber, input.legKind, input.counterpartyId],
    );
    const leg = inserted.rows[0];
    if (!leg) throw new Error("Payment leg insert did not return a record");

    await recordEvent(client, actor, "payment_leg.drafted", "payment_leg", leg.id, {
      paymentOrderId: input.paymentOrderId,
      sequenceNumber: input.sequenceNumber,
      legKind: input.legKind,
      counterpartyId: input.counterpartyId,
    });

    await client.query("COMMIT");
    return leg;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Internal preparation states that require no provider interaction. */
const internalOrderTransitions: Record<string, string[]> = {
  draft: ["pending_policy_decision", "cancelled"],
  pending_policy_decision: ["blocked", "manual_review", "approved", "cancelled"],
  manual_review: ["blocked", "approved", "cancelled"],
  blocked: ["manual_review", "cancelled"],
  approved: ["cancelled"],
};

/**
 * Provider-dependent states. These are deliberately unreachable through the
 * control plane: reaching them requires a verified provider instruction or
 * finality reference, which only an authorised provider integration can supply.
 */
const providerDependentOrderStates = new Set([
  "executing",
  "partially_completed",
  "completed",
  "failed",
]);

export async function transitionPostgresPaymentOrder(
  actor: WorkflowActor,
  input: { paymentOrderId: string; status: string; reason: string },
) {
  if (providerDependentOrderStates.has(input.status)) {
    throw new Error(
      "Execution states require a verified provider finality reference from an authorised provider integration; this transition fails closed",
    );
  }
  if (input.reason.trim().length < 10) {
    throw new Error("A substantive transition reason is required");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: string; policyDecisionId: string | null }>(
      `SELECT status::text AS status, policy_decision_id AS "policyDecisionId"
         FROM payment_orders WHERE id=$1 FOR UPDATE`,
      [input.paymentOrderId],
    );
    const order = current.rows[0];
    if (!order) throw new Error("Payment order was not found");
    if (!internalOrderTransitions[order.status]?.includes(input.status)) {
      throw new Error("invalid payment order lifecycle transition");
    }
    // Approval requires a recorded policy decision; the control plane never
    // approves an order on its own authority.
    if (input.status === "approved" && !order.policyDecisionId) {
      throw new Error("A recorded policy decision is required before an order may be approved");
    }

    const updated = await client.query<{ id: string; status: string }>(
      "UPDATE payment_orders SET status=$1::payment_status, updated_at=now() WHERE id=$2 RETURNING id, status::text AS status",
      [input.status, input.paymentOrderId],
    );
    const result = updated.rows[0];
    if (!result) throw new Error("Payment order update did not return a record");

    await recordEvent(client, actor, `payment_order.${input.status}`, "payment_order", result.id, {
      from: order.status,
      to: input.status,
      reason: input.reason,
    });

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Internal leg preparation states. A leg may be routed for a policy decision,
 * blocked, sent to manual review, approved for instruction, or cancelled — all
 * without contacting a provider.
 */
const internalLegTransitions: Record<string, string[]> = {
  draft: ["pending_policy_decision", "cancelled"],
  pending_policy_decision: ["blocked", "manual_review", "approved", "cancelled"],
  manual_review: ["blocked", "approved", "cancelled"],
  blocked: ["manual_review", "cancelled"],
  approved: ["cancelled"],
};

export function allowedInternalLegTransitions(status: string): string[] {
  return internalLegTransitions[status] ?? [];
}

/**
 * Transition a payment leg through its internal preparation lifecycle.
 *
 * Execution and settlement states are unreachable here for the same reason as
 * on the order: they assert something about the outside world that only an
 * authorised provider response can establish. A leg may only be approved once
 * its parent order has itself been approved against a recorded policy decision,
 * so an approved leg can never outrank its order.
 */
export async function transitionPostgresPaymentLeg(
  actor: WorkflowActor,
  input: { paymentLegId: string; status: string; reason: string },
) {
  if (providerDependentOrderStates.has(input.status)) {
    throw new Error(
      "Leg execution states require a verified provider instruction or finality reference from an authorised provider integration; this transition fails closed",
    );
  }
  if (input.reason.trim().length < 10) {
    throw new Error("A substantive transition reason is required");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      status: string;
      paymentOrderId: string;
      orderStatus: string;
      providerInstructionReference: string | null;
    }>(
      `SELECT l.status::text AS status, l.payment_order_id AS "paymentOrderId",
              o.status::text AS "orderStatus",
              l.provider_instruction_reference AS "providerInstructionReference"
         FROM payment_legs l
         JOIN payment_orders o ON o.id = l.payment_order_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [input.paymentLegId],
    );
    const leg = current.rows[0];
    if (!leg) throw new Error("Payment leg was not found");
    if (!internalLegTransitions[leg.status]?.includes(input.status)) {
      throw new Error("invalid payment leg lifecycle transition");
    }
    if (input.status === "approved" && leg.orderStatus !== "approved") {
      throw new Error("A leg may only be approved after its payment order is approved");
    }

    const updated = await client.query<{ id: string; status: string }>(
      "UPDATE payment_legs SET status=$1::payment_status WHERE id=$2 RETURNING id, status::text AS status",
      [input.status, input.paymentLegId],
    );
    const result = updated.rows[0];
    if (!result) throw new Error("Payment leg update did not return a record");

    await recordEvent(client, actor, `payment_leg.${input.status}`, "payment_leg", result.id, {
      from: leg.status,
      to: input.status,
      paymentOrderId: leg.paymentOrderId,
      orderStatus: leg.orderStatus,
      reason: input.reason,
    });

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
