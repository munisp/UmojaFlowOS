import {
  boolean,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["admin", "compliance_officer", "treasury_operator", "auditor"])
    .default("auditor")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const counterparties = mysqlTable(
  "counterparties",
  {
    id: int("id").autoincrement().primaryKey(),
    legalName: varchar("legalName", { length: 255 }).notNull(),
    counterpartyType: mysqlEnum("counterpartyType", [
      "licensed_psp",
      "correspondent_bank",
      "stablecoin_provider",
      "fx_liquidity_provider",
      "custody_provider",
      "kyc_provider",
      "sanctions_provider",
      "chain_analytics_provider",
      "notification_provider",
      "regulatory_submission_provider",
    ]).notNull(),
    jurisdiction: varchar("jurisdiction", { length: 64 }).notNull(),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("counterparty_identity_idx").on(table.legalName, table.counterpartyType, table.jurisdiction)],
);

export const counterpartyAuthorizations = mysqlTable(
  "counterpartyAuthorizations",
  {
    id: int("id").autoincrement().primaryKey(),
    counterpartyId: int("counterpartyId").notNull(),
    regulator: mysqlEnum("regulator", ["CBN", "CBK", "SARB", "SEC", "CMA", "FSCA", "FIC"]).notNull(),
    licenceReference: varchar("licenceReference", { length: 255 }).notNull(),
    scopeDescription: text("scopeDescription").notNull(),
    evidenceUrl: varchar("evidenceUrl", { length: 2048 }).notNull(),
    validFrom: datetime("validFrom").notNull(),
    validTo: datetime("validTo"),
    status: mysqlEnum("status", ["pending_review", "verified", "expired", "suspended", "rejected"])
      .default("pending_review")
      .notNull(),
    verifiedBy: varchar("verifiedBy", { length: 64 }),
    verifiedAt: timestamp("verifiedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("counterparty_authorization_idx").on(table.counterpartyId, table.regulator, table.licenceReference)],
);

export const integrationConnections = mysqlTable(
  "integrationConnections",
  {
    id: int("id").autoincrement().primaryKey(),
    counterpartyId: int("counterpartyId").notNull(),
    category: mysqlEnum("category", [
      "payment_rail",
      "fx_rate",
      "stablecoin_market_data",
      "kyc_kyb",
      "sanctions",
      "chain_analytics",
      "notification",
      "regulatory_submission",
    ]).notNull(),
    environment: mysqlEnum("environment", ["sandbox", "production"]).notNull(),
    documentationUrl: varchar("documentationUrl", { length: 2048 }).notNull(),
    secretReference: varchar("secretReference", { length: 255 }),
    state: mysqlEnum("state", ["unconfigured", "credential_pending", "verification_pending", "active", "suspended", "failed"])
      .default("unconfigured")
      .notNull(),
    lastHealthCheckedAt: timestamp("lastHealthCheckedAt"),
    lastHealthResult: json("lastHealthResult"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("integration_identity_idx").on(table.counterpartyId, table.category, table.environment)],
);

export const corridorPolicies = mysqlTable(
  "corridorPolicies",
  {
    id: int("id").autoincrement().primaryKey(),
    corridor: mysqlEnum("corridor", ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).notNull(),
    regulator: mysqlEnum("regulator", ["CBN", "CBK", "SARB"]).notNull(),
    policyVersion: varchar("policyVersion", { length: 128 }).notNull(),
    effectiveFrom: datetime("effectiveFrom").notNull(),
    effectiveTo: datetime("effectiveTo"),
    requiresTravelRule: boolean("requiresTravelRule").default(false).notNull(),
    requiresAuthorizedFxIntermediary: boolean("requiresAuthorizedFxIntermediary").default(true).notNull(),
    activationStatus: mysqlEnum("activationStatus", ["pending_review", "verified", "expired", "suspended", "rejected"])
      .default("pending_review")
      .notNull(),
    policyDocumentUrl: varchar("policyDocumentUrl", { length: 2048 }).notNull(),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("corridor_policy_version_idx").on(table.corridor, table.policyVersion)],
);

export const customers = mysqlTable(
  "customers",
  {
    id: int("id").autoincrement().primaryKey(),
    legalName: varchar("legalName", { length: 255 }).notNull(),
    registrationIdentifier: varchar("registrationIdentifier", { length: 255 }).notNull(),
    kycStatus: mysqlEnum("kycStatus", ["open", "under_review", "cleared", "escalated", "reported", "closed"])
      .default("open")
      .notNull(),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("customer_identity_idx").on(table.legalName, table.registrationIdentifier)],
);

export const beneficiaries = mysqlTable(
  "beneficiaries",
  {
    id: int("id").autoincrement().primaryKey(),
    customerId: int("customerId").notNull(),
    legalName: varchar("legalName", { length: 255 }).notNull(),
    countryCode: varchar("countryCode", { length: 2 }).notNull(),
    bankOrWalletReference: varchar("bankOrWalletReference", { length: 512 }).notNull(),
    screeningState: mysqlEnum("screeningState", ["not_run", "clear", "potential_match", "confirmed_match", "source_unavailable"])
      .default("not_run")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("beneficiary_identity_idx").on(table.customerId, table.legalName, table.bankOrWalletReference)],
);

export const liquidityPositions = mysqlTable(
  "liquidityPositions",
  {
    id: int("id").autoincrement().primaryKey(),
    corridor: mysqlEnum("corridor", ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).notNull(),
    currency: mysqlEnum("currency", ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]).notNull(),
    accountKind: mysqlEnum("accountKind", ["liquidity_pool", "nostro", "vostro", "prefunding", "custody_wallet"]).notNull(),
    accountReference: varchar("accountReference", { length: 255 }).notNull(),
    availableAmount: decimal("availableAmount", { precision: 30, scale: 12 }).notNull(),
    reservedAmount: decimal("reservedAmount", { precision: 30, scale: 12 }).default("0").notNull(),
    sourceReference: varchar("sourceReference", { length: 512 }).notNull(),
    reconciledAt: datetime("reconciledAt").notNull(),
    recordedBy: varchar("recordedBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("liquidity_corridor_idx").on(table.corridor, table.currency, table.reconciledAt)],
);

export const marketObservations = mysqlTable(
  "marketObservations",
  {
    id: int("id").autoincrement().primaryKey(),
    integrationConnectionId: int("integrationConnectionId").notNull(),
    baseAsset: mysqlEnum("baseAsset", ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]).notNull(),
    quoteAsset: mysqlEnum("quoteAsset", ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]).notNull(),
    rate: decimal("rate", { precision: 30, scale: 12 }).notNull(),
    observedAt: datetime("observedAt").notNull(),
    sourceReference: varchar("sourceReference", { length: 2048 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("market_pair_idx").on(table.baseAsset, table.quoteAsset, table.observedAt)],
);

export const rateLocks = mysqlTable(
  "rateLocks",
  {
    id: int("id").autoincrement().primaryKey(),
    marketObservationId: int("marketObservationId").notNull(),
    paymentOrderId: int("paymentOrderId"),
    corridor: mysqlEnum("corridor", ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).notNull(),
    baseAsset: mysqlEnum("baseAsset", ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]).notNull(),
    quoteAsset: mysqlEnum("quoteAsset", ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]).notNull(),
    lockedRate: decimal("lockedRate", { precision: 30, scale: 12 }).notNull(),
    expiresAt: datetime("expiresAt").notNull(),
    status: mysqlEnum("status", ["locked", "expired", "cancelled"]).default("locked").notNull(),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("rate_lock_status_idx").on(table.corridor, table.status, table.expiresAt)],
);

export const paymentOrders = mysqlTable(
  "paymentOrders",
  {
    id: int("id").autoincrement().primaryKey(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull().unique(),
    customerId: int("customerId").notNull(),
    beneficiaryId: int("beneficiaryId").notNull(),
    corridor: mysqlEnum("corridor", ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).notNull(),
    sourceCurrency: mysqlEnum("sourceCurrency", ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]).notNull(),
    sourceAmount: decimal("sourceAmount", { precision: 30, scale: 12 }).notNull(),
    targetCurrency: mysqlEnum("targetCurrency", ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]).notNull(),
    targetAmount: decimal("targetAmount", { precision: 30, scale: 12 }),
    status: mysqlEnum("status", ["draft", "pending_policy_decision", "blocked", "manual_review", "approved", "executing", "partially_completed", "completed", "failed", "cancelled"])
      .default("draft")
      .notNull(),
    policyDecisionReference: varchar("policyDecisionReference", { length: 255 }),
    providerFinalityReference: varchar("providerFinalityReference", { length: 512 }),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("payment_corridor_status_idx").on(table.corridor, table.status, table.createdAt)],
);

export const paymentLegs = mysqlTable(
  "paymentLegs",
  {
    id: int("id").autoincrement().primaryKey(),
    paymentOrderId: int("paymentOrderId").notNull(),
    sequenceNumber: int("sequenceNumber").notNull(),
    legKind: mysqlEnum("legKind", ["collection", "fx", "stablecoin_settlement", "payout", "reversal"]).notNull(),
    counterpartyId: int("counterpartyId"),
    status: mysqlEnum("status", ["draft", "pending_policy_decision", "blocked", "manual_review", "approved", "executing", "partially_completed", "completed", "failed", "cancelled"])
      .default("draft")
      .notNull(),
    providerInstructionReference: varchar("providerInstructionReference", { length: 512 }),
    providerFinalityReference: varchar("providerFinalityReference", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [uniqueIndex("payment_leg_sequence_idx").on(table.paymentOrderId, table.sequenceNumber)],
);

export const complianceCases = mysqlTable(
  "complianceCases",
  {
    id: int("id").autoincrement().primaryKey(),
    paymentOrderId: int("paymentOrderId"),
    customerId: int("customerId"),
    caseType: mysqlEnum("caseType", ["kyc", "sanctions", "transaction_monitoring", "travel_rule", "counterparty", "sar_str"]).notNull(),
    status: mysqlEnum("status", ["open", "under_review", "cleared", "escalated", "reported", "closed"]).default("open").notNull(),
    severity: mysqlEnum("severity", ["low", "medium", "high", "critical"]).notNull(),
    sourceReference: varchar("sourceReference", { length: 2048 }).notNull(),
    decisionReason: text("decisionReason"),
    openedAt: timestamp("openedAt").defaultNow().notNull(),
    closedAt: timestamp("closedAt"),
  },
  table => [index("compliance_case_status_idx").on(table.status, table.severity, table.openedAt)],
);

export const regulatoryReports = mysqlTable(
  "regulatoryReports",
  {
    id: int("id").autoincrement().primaryKey(),
    regulator: mysqlEnum("regulator", ["CBN", "CBK", "SARB"]).notNull(),
    corridor: mysqlEnum("corridor", ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).notNull(),
    reportType: varchar("reportType", { length: 255 }).notNull(),
    periodStart: datetime("periodStart").notNull(),
    periodEnd: datetime("periodEnd").notNull(),
    status: mysqlEnum("status", ["draft", "validated", "pending_submission", "submitted", "rejected", "submission_unavailable"])
      .default("draft")
      .notNull(),
    artifactUrl: varchar("artifactUrl", { length: 2048 }),
    evidenceManifest: json("evidenceManifest"),
    submissionReference: varchar("submissionReference", { length: 512 }),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("regulatory_report_idx").on(table.regulator, table.corridor, table.periodEnd)],
);

export const regulatoryDeadlines = mysqlTable(
  "regulatoryDeadlines",
  {
    id: int("id").autoincrement().primaryKey(),
    regulator: mysqlEnum("regulator", ["CBN", "CBK", "SARB"]).notNull(),
    corridor: mysqlEnum("corridor", ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    dueAt: datetime("dueAt").notNull(),
    sourceReference: varchar("sourceReference", { length: 2048 }).notNull(),
    status: mysqlEnum("status", ["open", "acknowledged", "completed", "cancelled"]).default("open").notNull(),
    lastRemindedAt: timestamp("lastRemindedAt"),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("regulatory_deadline_due_idx").on(table.status, table.dueAt)],
);

export const notificationDeliveries = mysqlTable(
  "notificationDeliveries",
  {
    id: int("id").autoincrement().primaryKey(),
    alertPolicyId: int("alertPolicyId"),
    alertType: mysqlEnum("alertType", ["liquidity_threshold", "payment_failure", "compliance_flag", "regulatory_deadline"]).notNull(),
    deliveryState: mysqlEnum("deliveryState", ["accepted", "unavailable"]).notNull(),
    destination: varchar("destination", { length: 64 }).notNull(),
    correlationId: varchar("correlationId", { length: 128 }).notNull(),
    payloadHash: varchar("payloadHash", { length: 128 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("notification_delivery_idx").on(table.alertType, table.createdAt)],
);

export const scheduledJobs = mysqlTable(
  "scheduledJobs",
  {
    id: int("id").autoincrement().primaryKey(),
    purpose: mysqlEnum("purpose", ["regulatory_deadline_reminders"]).notNull().unique(),
    scheduleCronTaskUid: varchar("scheduleCronTaskUid", { length: 65 }).unique(),
    cronExpression: varchar("cronExpression", { length: 64 }).notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    lastExecutedAt: timestamp("lastExecutedAt"),
    createdBy: varchar("createdBy", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("scheduled_job_task_idx").on(table.scheduleCronTaskUid)],
);

export const alertPolicies = mysqlTable("alertPolicies", {
  id: int("id").autoincrement().primaryKey(),
  alertType: mysqlEnum("alertType", ["liquidity_threshold", "payment_failure", "compliance_flag", "regulatory_deadline"]).notNull(),
  corridor: mysqlEnum("corridor", ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]),
  threshold: json("threshold").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdBy: varchar("createdBy", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const activityEvents = mysqlTable(
  "activityEvents",
  {
    id: int("id").autoincrement().primaryKey(),
    actorSubject: varchar("actorSubject", { length: 64 }).notNull(),
    actorRole: mysqlEnum("actorRole", ["admin", "compliance_officer", "treasury_operator", "auditor"]).notNull(),
    action: varchar("action", { length: 255 }).notNull(),
    objectType: varchar("objectType", { length: 128 }).notNull(),
    objectId: varchar("objectId", { length: 128 }),
    correlationId: varchar("correlationId", { length: 128 }).notNull(),
    beforeHash: varchar("beforeHash", { length: 128 }),
    afterHash: varchar("afterHash", { length: 128 }),
    policyVersion: varchar("policyVersion", { length: 128 }),
    metadata: json("metadata"),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  table => [index("activity_object_idx").on(table.objectType, table.objectId, table.occurredAt)],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
