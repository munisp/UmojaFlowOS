import { and, desc, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createHash, randomUUID } from "node:crypto";
import {
  activityEvents,
  alertPolicies,
  beneficiaries,
  complianceCases,
  corridorPolicies,
  counterparties,
  counterpartyAuthorizations,
  customers,
  InsertUser,
  integrationConnections,
  liquidityPositions,
  marketObservations,
  notificationDeliveries,
  paymentLegs,
  paymentOrders,
  rateLocks,
  regulatoryDeadlines,
  regulatoryReports,
  scheduledJobs,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { notifyOwner } from "./_core/notification";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    _db = drizzle(process.env.DATABASE_URL);
  }
  return _db;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database connection is unavailable");
  return db;
}

type Actor = { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" };

async function recordActivity(actor: Actor, action: string, objectType: string, objectId?: string, metadata?: Record<string, unknown>) {
  const db = await requireDb();
  await db.insert(activityEvents).values({
    actorSubject: actor.openId,
    actorRole: actor.role,
    action,
    objectType,
    objectId,
    correlationId: randomUUID(),
    metadata: metadata ?? {},
  });
}

function thresholdMinimum(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).minimum;
  if (typeof candidate !== "string" && typeof candidate !== "number") return undefined;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function notifyForAlertPolicies(
  actor: Actor,
  alertType: "liquidity_threshold" | "payment_failure" | "compliance_flag" | "regulatory_deadline",
  corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR" | undefined,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
) {
  const db = await requireDb();
  const policies = await db.select().from(alertPolicies).where(eq(alertPolicies.alertType, alertType));
  const enabled = policies.filter(policy => policy.enabled && (!policy.corridor || policy.corridor === corridor));
  if (!enabled.length) return;
  const delivered = await notifyOwner({ title, content });
  const deliveryState: "accepted" | "unavailable" = delivered ? "accepted" : "unavailable";
  const correlationId = randomUUID();
  const payloadHash = createHash("sha256").update(`${title}\n${content}`).digest("hex");
  await db.insert(notificationDeliveries).values(enabled.map(policy => ({
    alertPolicyId: policy.id,
    alertType,
    deliveryState,
    destination: "project_owner",
    correlationId,
    payloadHash,
  })));
  await recordActivity(actor, "operational_alert.delivery_attempted", "alert_delivery", undefined, {
    ...metadata,
    alertType,
    policyIds: enabled.map(policy => policy.id),
    delivered,
  });
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await requireDb();
  const values: InsertUser = { openId: user.openId, lastSignedIn: user.lastSignedIn ?? new Date() };
  const updateSet: Record<string, unknown> = { lastSignedIn: values.lastSignedIn };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await requireDb();
  return (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
}

export async function getDashboardSnapshot() {
  const db = await requireDb();
  const [counterpartyCounts, integrationCounts, paymentCounts, caseCounts, reportCounts, latestEvents] = await Promise.all([
    db.select({ state: counterparties.counterpartyType, count: sql<number>`count(*)` }).from(counterparties).groupBy(counterparties.counterpartyType),
    db.select({ state: integrationConnections.state, count: sql<number>`count(*)` }).from(integrationConnections).groupBy(integrationConnections.state),
    db.select({ state: paymentOrders.status, count: sql<number>`count(*)` }).from(paymentOrders).groupBy(paymentOrders.status),
    db.select({ state: complianceCases.status, count: sql<number>`count(*)` }).from(complianceCases).groupBy(complianceCases.status),
    db.select({ state: regulatoryReports.status, count: sql<number>`count(*)` }).from(regulatoryReports).groupBy(regulatoryReports.status),
    db.select().from(activityEvents).orderBy(desc(activityEvents.occurredAt)).limit(12),
  ]);
  return { counterpartyCounts, integrationCounts, paymentCounts, caseCounts, reportCounts, latestEvents };
}

export async function listCounterparties() {
  const db = await requireDb();
  return db.select().from(counterparties).orderBy(desc(counterparties.updatedAt));
}

export async function createCounterparty(actor: Actor, input: { legalName: string; counterpartyType: typeof counterparties.$inferInsert.counterpartyType; jurisdiction: string }) {
  const db = await requireDb();
  const result = await db.insert(counterparties).values({ ...input, createdBy: actor.openId });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "counterparty.created", "counterparty", String(id), { type: input.counterpartyType, jurisdiction: input.jurisdiction });
  return id;
}

export async function createCounterpartyAuthorization(actor: Actor, input: Omit<typeof counterpartyAuthorizations.$inferInsert, "id" | "createdAt" | "verifiedBy" | "verifiedAt">) {
  const db = await requireDb();
  const result = await db.insert(counterpartyAuthorizations).values(input);
  const id = Number(result[0].insertId);
  await recordActivity(actor, "counterparty.authorization_created", "counterparty_authorization", String(id), { counterpartyId: input.counterpartyId, regulator: input.regulator });
  return id;
}

export async function listCounterpartyAuthorizations() {
  const db = await requireDb();
  return db
    .select({ authorization: counterpartyAuthorizations, counterpartyName: counterparties.legalName })
    .from(counterpartyAuthorizations)
    .innerJoin(counterparties, eq(counterpartyAuthorizations.counterpartyId, counterparties.id))
    .orderBy(desc(counterpartyAuthorizations.createdAt));
}

export async function transitionCounterpartyAuthorization(actor: Actor, input: { authorizationId: number; status: "pending_review" | "verified" | "expired" | "suspended" | "rejected" }) {
  const db = await requireDb();
  const authorization = await db.select().from(counterpartyAuthorizations).where(eq(counterpartyAuthorizations.id, input.authorizationId)).limit(1);
  if (!authorization[0]) throw new Error("The counterparty authorisation does not exist");
  const isVerified = input.status === "verified";
  await db.update(counterpartyAuthorizations).set({
    status: input.status,
    verifiedBy: isVerified ? actor.openId : authorization[0].verifiedBy,
    verifiedAt: isVerified ? new Date() : authorization[0].verifiedAt,
  }).where(eq(counterpartyAuthorizations.id, input.authorizationId));
  await recordActivity(actor, "counterparty.authorization_transitioned", "counterparty_authorization", String(input.authorizationId), { priorStatus: authorization[0].status, status: input.status, counterpartyId: authorization[0].counterpartyId });
  return { id: input.authorizationId, status: input.status };
}

export async function listIntegrations() {
  const db = await requireDb();
  return db
    .select({ integration: integrationConnections, counterpartyName: counterparties.legalName })
    .from(integrationConnections)
    .innerJoin(counterparties, eq(integrationConnections.counterpartyId, counterparties.id))
    .orderBy(desc(integrationConnections.createdAt));
}

export async function createIntegrationConnection(actor: Actor, input: Omit<typeof integrationConnections.$inferInsert, "id" | "createdAt" | "lastHealthCheckedAt" | "lastHealthResult">) {
  const db = await requireDb();
  const result = await db.insert(integrationConnections).values(input);
  const id = Number(result[0].insertId);
  await recordActivity(actor, "integration.connection_created", "integration_connection", String(id), { category: input.category, environment: input.environment, state: input.state });
  return id;
}

export async function listCorridorPolicies() {
  const db = await requireDb();
  return db.select().from(corridorPolicies).orderBy(desc(corridorPolicies.effectiveFrom));
}

export async function listCustomers() {
  const db = await requireDb();
  return db.select().from(customers).orderBy(desc(customers.createdAt));
}

export async function createCustomer(actor: Actor, input: Omit<typeof customers.$inferInsert, "id" | "createdAt" | "createdBy" | "kycStatus">) {
  const db = await requireDb();
  const result = await db.insert(customers).values({ ...input, createdBy: actor.openId, kycStatus: "open" });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "customer.created", "customer", String(id), { registrationIdentifier: input.registrationIdentifier });
  return id;
}

export async function listBeneficiaries(customerId?: number) {
  const db = await requireDb();
  if (customerId) return db.select().from(beneficiaries).where(eq(beneficiaries.customerId, customerId)).orderBy(desc(beneficiaries.createdAt));
  return db.select().from(beneficiaries).orderBy(desc(beneficiaries.createdAt));
}

export async function createBeneficiary(actor: Actor, input: Omit<typeof beneficiaries.$inferInsert, "id" | "createdAt" | "screeningState">) {
  const db = await requireDb();
  const customer = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
  if (!customer[0]) throw new Error("A real customer record is required before creating a beneficiary");
  const result = await db.insert(beneficiaries).values({ ...input, screeningState: "not_run" });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "beneficiary.created", "beneficiary", String(id), { customerId: input.customerId, countryCode: input.countryCode });
  return id;
}

export async function createCorridorPolicy(actor: Actor, input: Omit<typeof corridorPolicies.$inferInsert, "id" | "createdAt" | "createdBy">) {
  const db = await requireDb();
  const result = await db.insert(corridorPolicies).values({ ...input, createdBy: actor.openId });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "corridor_policy.created", "corridor_policy", String(id), { corridor: input.corridor, regulator: input.regulator, policyVersion: input.policyVersion });
  return id;
}

export async function listLiquidityPositions() {
  const db = await requireDb();
  return db.select().from(liquidityPositions).orderBy(desc(liquidityPositions.reconciledAt));
}

export async function recordLiquidityPosition(actor: Actor, input: Omit<typeof liquidityPositions.$inferInsert, "id" | "createdAt" | "recordedBy">) {
  const db = await requireDb();
  const result = await db.insert(liquidityPositions).values({ ...input, recordedBy: actor.openId });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "liquidity_position.recorded", "liquidity_position", String(id), { corridor: input.corridor, currency: input.currency, accountKind: input.accountKind });
  const policies = await db.select().from(alertPolicies).where(eq(alertPolicies.alertType, "liquidity_threshold"));
  const breached = policies.some(policy => {
    const minimum = thresholdMinimum(policy.threshold);
    return policy.enabled && (!policy.corridor || policy.corridor === input.corridor) && minimum !== undefined && Number(input.availableAmount) < minimum;
  });
  if (breached) {
    await notifyForAlertPolicies(
      actor,
      "liquidity_threshold",
      input.corridor,
      "UmojaFlowOS liquidity threshold breach",
      `A recorded ${input.accountKind.replaceAll("_", " ")} position for ${input.corridor} has available amount ${input.availableAmount} ${input.currency}, below a configured policy minimum.`,
      { liquidityPositionId: id, availableAmount: input.availableAmount, currency: input.currency },
    );
  }
  return id;
}

export async function listMarketObservations() {
  const db = await requireDb();
  return db.select().from(marketObservations).orderBy(desc(marketObservations.observedAt)).limit(100);
}

export async function recordMarketObservation(actor: Actor, input: Omit<typeof marketObservations.$inferInsert, "id" | "createdAt">) {
  const db = await requireDb();
  const activeIntegration = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.id, input.integrationConnectionId), eq(integrationConnections.state, "active")))
    .limit(1);
  if (!activeIntegration[0]) throw new Error("Market observations require an active, verified market-data integration");
  const result = await db.insert(marketObservations).values(input);
  const id = Number(result[0].insertId);
  await recordActivity(actor, "market_observation.recorded", "market_observation", String(id), { baseAsset: input.baseAsset, quoteAsset: input.quoteAsset, sourceReference: input.sourceReference });
  return id;
}

export async function listRateLocks() {
  const db = await requireDb();
  return db.select().from(rateLocks).orderBy(desc(rateLocks.createdAt)).limit(100);
}

export async function createRateLock(actor: Actor, input: { marketObservationId: number; paymentOrderId?: number; corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR"; expiresAt: Date }) {
  const db = await requireDb();
  if (input.expiresAt <= new Date()) throw new Error("A rate lock expiry must be in the future");
  const observation = await db.select().from(marketObservations).where(eq(marketObservations.id, input.marketObservationId)).limit(1);
  if (!observation[0]) throw new Error("A source-stamped market observation is required for a rate lock");
  if (input.paymentOrderId) {
    const payment = await db.select({ id: paymentOrders.id }).from(paymentOrders).where(eq(paymentOrders.id, input.paymentOrderId)).limit(1);
    if (!payment[0]) throw new Error("The linked payment order does not exist");
  }
  const result = await db.insert(rateLocks).values({
    marketObservationId: input.marketObservationId,
    paymentOrderId: input.paymentOrderId,
    corridor: input.corridor,
    baseAsset: observation[0].baseAsset,
    quoteAsset: observation[0].quoteAsset,
    lockedRate: observation[0].rate,
    expiresAt: input.expiresAt,
    createdBy: actor.openId,
  });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "rate_lock.created", "rate_lock", String(id), { marketObservationId: input.marketObservationId, paymentOrderId: input.paymentOrderId, corridor: input.corridor });
  return id;
}

export async function cancelRateLock(actor: Actor, rateLockId: number) {
  const db = await requireDb();
  const lock = await db.select().from(rateLocks).where(eq(rateLocks.id, rateLockId)).limit(1);
  if (!lock[0]) throw new Error("The rate lock does not exist");
  if (lock[0].status !== "locked") throw new Error("Only an active rate lock can be cancelled");
  await db.update(rateLocks).set({ status: "cancelled" }).where(eq(rateLocks.id, rateLockId));
  await recordActivity(actor, "rate_lock.cancelled", "rate_lock", String(rateLockId), { priorStatus: lock[0].status });
  return { id: rateLockId, status: "cancelled" as const };
}

export async function expireRateLocks(actor: Actor, now = new Date()) {
  const db = await requireDb();
  const result = await db.update(rateLocks).set({ status: "expired" }).where(and(eq(rateLocks.status, "locked"), lte(rateLocks.expiresAt, now)));
  const expired = Number(result[0].affectedRows ?? 0);
  await recordActivity(actor, "rate_lock.expiry_evaluated", "rate_lock", undefined, { expired, evaluatedAt: now.toISOString() });
  return { expired };
}

export async function listPaymentOrders() {
  const db = await requireDb();
  return db.select().from(paymentOrders).orderBy(desc(paymentOrders.createdAt)).limit(100);
}

export async function listPaymentLegs(paymentOrderId?: number) {
  const db = await requireDb();
  if (paymentOrderId) return db.select().from(paymentLegs).where(eq(paymentLegs.paymentOrderId, paymentOrderId)).orderBy(paymentLegs.sequenceNumber);
  return db.select().from(paymentLegs).orderBy(desc(paymentLegs.createdAt)).limit(100);
}

export async function transitionPaymentLeg(actor: Actor, input: { paymentLegId: number; status: "blocked" | "cancelled" }) {
  const db = await requireDb();
  const leg = await db.select().from(paymentLegs).where(eq(paymentLegs.id, input.paymentLegId)).limit(1);
  if (!leg[0]) throw new Error("The payment leg does not exist");
  if (leg[0].status === "completed" || leg[0].status === "cancelled") throw new Error("A finalised payment leg cannot be changed");
  await db.update(paymentLegs).set({ status: input.status }).where(eq(paymentLegs.id, input.paymentLegId));
  await recordActivity(actor, "payment_leg.transitioned", "payment_leg", String(input.paymentLegId), { priorStatus: leg[0].status, status: input.status });
  return { id: input.paymentLegId, status: input.status };
}

export async function createPaymentLeg(actor: Actor, input: { paymentOrderId: number; sequenceNumber: number; legKind: "collection" | "fx" | "stablecoin_settlement" | "payout" | "reversal"; counterpartyId?: number }) {
  const db = await requireDb();
  const payment = await db.select({ id: paymentOrders.id }).from(paymentOrders).where(eq(paymentOrders.id, input.paymentOrderId)).limit(1);
  if (!payment[0]) throw new Error("The payment order does not exist");
  if (input.counterpartyId) {
    const counterparty = await db.select({ id: counterparties.id }).from(counterparties).where(eq(counterparties.id, input.counterpartyId)).limit(1);
    if (!counterparty[0]) throw new Error("The selected counterparty does not exist");
  }
  const result = await db.insert(paymentLegs).values({ ...input, status: "draft" });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "payment_leg.created", "payment_leg", String(id), { paymentOrderId: input.paymentOrderId, sequenceNumber: input.sequenceNumber, legKind: input.legKind });
  return id;
}

export async function createPaymentOrder(actor: Actor, input: Omit<typeof paymentOrders.$inferInsert, "id" | "createdAt" | "updatedAt" | "createdBy" | "status" | "policyDecisionReference" | "providerFinalityReference">) {
  const db = await requireDb();
  const customer = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
  const beneficiary = await db.select({ id: beneficiaries.id }).from(beneficiaries).where(eq(beneficiaries.id, input.beneficiaryId)).limit(1);
  if (!customer[0] || !beneficiary[0]) throw new Error("A real customer and beneficiary must exist before an order can be drafted");
  const result = await db.insert(paymentOrders).values({ ...input, createdBy: actor.openId, status: "pending_policy_decision" });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "payment_order.created", "payment_order", String(id), { corridor: input.corridor, state: "pending_policy_decision" });
  return id;
}

export async function listComplianceCases() {
  const db = await requireDb();
  return db.select().from(complianceCases).orderBy(desc(complianceCases.openedAt)).limit(100);
}

export async function createComplianceCase(actor: Actor, input: Omit<typeof complianceCases.$inferInsert, "id" | "openedAt" | "closedAt">) {
  const db = await requireDb();
  const result = await db.insert(complianceCases).values(input);
  const id = Number(result[0].insertId);
  await recordActivity(actor, "compliance_case.created", "compliance_case", String(id), { caseType: input.caseType, severity: input.severity });
  if (input.severity === "high" || input.severity === "critical") {
    await notifyForAlertPolicies(
      actor,
      "compliance_flag",
      undefined,
      `UmojaFlowOS ${input.severity} compliance case`,
      `A ${input.severity} ${input.caseType.replaceAll("_", " ")} case was opened with verified source evidence. Review case ${id} in the compliance console.`,
      { complianceCaseId: id, caseType: input.caseType, severity: input.severity },
    );
  }
  return id;
}

export async function listRegulatoryReports() {
  const db = await requireDb();
  return db.select().from(regulatoryReports).orderBy(desc(regulatoryReports.periodEnd)).limit(100);
}

export async function listRegulatoryDeadlines() {
  const db = await requireDb();
  return db.select().from(regulatoryDeadlines).orderBy(regulatoryDeadlines.dueAt).limit(100);
}

export async function createRegulatoryDeadline(actor: Actor, input: Omit<typeof regulatoryDeadlines.$inferInsert, "id" | "createdAt" | "createdBy" | "status" | "lastRemindedAt">) {
  const db = await requireDb();
  const result = await db.insert(regulatoryDeadlines).values({ ...input, createdBy: actor.openId, status: "open" });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "regulatory_deadline.created", "regulatory_deadline", String(id), { regulator: input.regulator, corridor: input.corridor, dueAt: input.dueAt.toISOString() });
  return id;
}

export async function evaluateRegulatoryDeadlineAlerts(actor: Actor, now = new Date()) {
  const db = await requireDb();
  const horizon = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const deadlines = await db.select().from(regulatoryDeadlines).where(eq(regulatoryDeadlines.status, "open"));
  let reminded = 0;
  for (const deadline of deadlines) {
    const dueAt = new Date(deadline.dueAt);
    const alreadyRemindedToday = deadline.lastRemindedAt && new Date(deadline.lastRemindedAt).toDateString() === now.toDateString();
    if (dueAt > horizon || alreadyRemindedToday) continue;
    await notifyForAlertPolicies(actor, "regulatory_deadline", deadline.corridor, `UmojaFlowOS ${deadline.regulator} reporting deadline`, `${deadline.title} is due at ${dueAt.toISOString()}. Review the source evidence and report-pack status before the deadline.`, { deadlineId: deadline.id, regulator: deadline.regulator, dueAt: dueAt.toISOString() });
    await db.update(regulatoryDeadlines).set({ lastRemindedAt: now }).where(eq(regulatoryDeadlines.id, deadline.id));
    reminded += 1;
  }
  await recordActivity(actor, "regulatory_deadline.evaluated", "regulatory_deadline", undefined, { evaluated: deadlines.length, reminded, horizon: horizon.toISOString() });
  return { evaluated: deadlines.length, reminded };
}

export async function getScheduledJobByTaskUid(taskUid: string) {
  const db = await requireDb();
  return (await db.select().from(scheduledJobs).where(eq(scheduledJobs.scheduleCronTaskUid, taskUid)).limit(1))[0];
}

export async function createRegulatoryDeadlineReminderJob(actor: Actor, input: { taskUid: string; cronExpression: string }) {
  const db = await requireDb();
  const existing = await db.select({ id: scheduledJobs.id }).from(scheduledJobs).where(eq(scheduledJobs.purpose, "regulatory_deadline_reminders")).limit(1);
  if (existing[0]) throw new Error("The regulatory deadline reminder job already exists");
  const result = await db.insert(scheduledJobs).values({
    purpose: "regulatory_deadline_reminders",
    scheduleCronTaskUid: input.taskUid,
    cronExpression: input.cronExpression,
    enabled: true,
    createdBy: actor.openId,
  });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "scheduled_job.created", "scheduled_job", String(id), { purpose: "regulatory_deadline_reminders", taskUid: input.taskUid, cronExpression: input.cronExpression });
  return id;
}

export async function markScheduledJobExecuted(taskUid: string, executedAt = new Date()) {
  const db = await requireDb();
  await db.update(scheduledJobs).set({ lastExecutedAt: executedAt }).where(eq(scheduledJobs.scheduleCronTaskUid, taskUid));
}

export async function createRegulatoryReport(actor: Actor, input: Omit<typeof regulatoryReports.$inferInsert, "id" | "createdAt" | "createdBy" | "status" | "artifactUrl" | "evidenceManifest" | "submissionReference">) {
  const db = await requireDb();
  const result = await db.insert(regulatoryReports).values({ ...input, createdBy: actor.openId, status: "draft" });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "regulatory_report.created", "regulatory_report", String(id), { regulator: input.regulator, corridor: input.corridor, reportType: input.reportType });
  return id;
}

export async function listAlertPolicies() {
  const db = await requireDb();
  return db.select().from(alertPolicies).orderBy(desc(alertPolicies.createdAt));
}

export async function createAlertPolicy(actor: Actor, input: Omit<typeof alertPolicies.$inferInsert, "id" | "createdAt" | "createdBy">) {
  const db = await requireDb();
  const result = await db.insert(alertPolicies).values({ ...input, createdBy: actor.openId });
  const id = Number(result[0].insertId);
  await recordActivity(actor, "alert_policy.created", "alert_policy", String(id), { alertType: input.alertType, corridor: input.corridor });
  return id;
}
