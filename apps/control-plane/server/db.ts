import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { randomUUID } from "node:crypto";
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
  paymentOrders,
  regulatoryReports,
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
  alertType: "liquidity_threshold" | "compliance_flag",
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

export async function listPaymentOrders() {
  const db = await requireDb();
  return db.select().from(paymentOrders).orderBy(desc(paymentOrders.createdAt)).limit(100);
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
