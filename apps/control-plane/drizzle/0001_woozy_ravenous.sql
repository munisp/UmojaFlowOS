CREATE TABLE `activityEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actorSubject` varchar(64) NOT NULL,
	`actorRole` enum('admin','compliance_officer','treasury_operator','auditor') NOT NULL,
	`action` varchar(255) NOT NULL,
	`objectType` varchar(128) NOT NULL,
	`objectId` varchar(128),
	`correlationId` varchar(128) NOT NULL,
	`beforeHash` varchar(128),
	`afterHash` varchar(128),
	`policyVersion` varchar(128),
	`metadata` json,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `activityEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alertPolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`alertType` enum('liquidity_threshold','payment_failure','compliance_flag','regulatory_deadline') NOT NULL,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR'),
	`threshold` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alertPolicies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `beneficiaries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`legalName` varchar(255) NOT NULL,
	`countryCode` varchar(2) NOT NULL,
	`bankOrWalletReference` varchar(512) NOT NULL,
	`screeningState` enum('not_run','clear','potential_match','confirmed_match','source_unavailable') NOT NULL DEFAULT 'not_run',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `beneficiaries_id` PRIMARY KEY(`id`),
	CONSTRAINT `beneficiary_identity_idx` UNIQUE(`customerId`,`legalName`,`bankOrWalletReference`)
);
--> statement-breakpoint
CREATE TABLE `complianceCases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`paymentOrderId` int,
	`customerId` int,
	`caseType` enum('kyc','sanctions','transaction_monitoring','travel_rule','counterparty','sar_str') NOT NULL,
	`status` enum('open','under_review','cleared','escalated','reported','closed') NOT NULL DEFAULT 'open',
	`severity` enum('low','medium','high','critical') NOT NULL,
	`sourceReference` varchar(2048) NOT NULL,
	`decisionReason` text,
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`closedAt` timestamp,
	CONSTRAINT `complianceCases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `corridorPolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR') NOT NULL,
	`regulator` enum('CBN','CBK','SARB') NOT NULL,
	`policyVersion` varchar(128) NOT NULL,
	`effectiveFrom` datetime NOT NULL,
	`effectiveTo` datetime,
	`requiresTravelRule` boolean NOT NULL DEFAULT false,
	`requiresAuthorizedFxIntermediary` boolean NOT NULL DEFAULT true,
	`activationStatus` enum('pending_review','verified','expired','suspended','rejected') NOT NULL DEFAULT 'pending_review',
	`policyDocumentUrl` varchar(2048) NOT NULL,
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `corridorPolicies_id` PRIMARY KEY(`id`),
	CONSTRAINT `corridor_policy_version_idx` UNIQUE(`corridor`,`policyVersion`)
);
--> statement-breakpoint
CREATE TABLE `counterparties` (
	`id` int AUTO_INCREMENT NOT NULL,
	`legalName` varchar(255) NOT NULL,
	`counterpartyType` enum('licensed_psp','correspondent_bank','stablecoin_provider','fx_liquidity_provider','custody_provider','kyc_provider','sanctions_provider','chain_analytics_provider','notification_provider','regulatory_submission_provider') NOT NULL,
	`jurisdiction` varchar(64) NOT NULL,
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `counterparties_id` PRIMARY KEY(`id`),
	CONSTRAINT `counterparty_identity_idx` UNIQUE(`legalName`,`counterpartyType`,`jurisdiction`)
);
--> statement-breakpoint
CREATE TABLE `counterpartyAuthorizations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`counterpartyId` int NOT NULL,
	`regulator` enum('CBN','CBK','SARB','SEC','CMA','FSCA','FIC') NOT NULL,
	`licenceReference` varchar(255) NOT NULL,
	`scopeDescription` text NOT NULL,
	`evidenceUrl` varchar(2048) NOT NULL,
	`validFrom` datetime NOT NULL,
	`validTo` datetime,
	`status` enum('pending_review','verified','expired','suspended','rejected') NOT NULL DEFAULT 'pending_review',
	`verifiedBy` varchar(64),
	`verifiedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `counterpartyAuthorizations_id` PRIMARY KEY(`id`),
	CONSTRAINT `counterparty_authorization_idx` UNIQUE(`counterpartyId`,`regulator`,`licenceReference`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`legalName` varchar(255) NOT NULL,
	`registrationIdentifier` varchar(255) NOT NULL,
	`kycStatus` enum('open','under_review','cleared','escalated','reported','closed') NOT NULL DEFAULT 'open',
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `customer_identity_idx` UNIQUE(`legalName`,`registrationIdentifier`)
);
--> statement-breakpoint
CREATE TABLE `integrationConnections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`counterpartyId` int NOT NULL,
	`category` enum('payment_rail','fx_rate','stablecoin_market_data','kyc_kyb','sanctions','chain_analytics','notification','regulatory_submission') NOT NULL,
	`environment` enum('sandbox','production') NOT NULL,
	`documentationUrl` varchar(2048) NOT NULL,
	`secretReference` varchar(255),
	`state` enum('unconfigured','credential_pending','verification_pending','active','suspended','failed') NOT NULL DEFAULT 'unconfigured',
	`lastHealthCheckedAt` timestamp,
	`lastHealthResult` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `integrationConnections_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_identity_idx` UNIQUE(`counterpartyId`,`category`,`environment`)
);
--> statement-breakpoint
CREATE TABLE `liquidityPositions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR') NOT NULL,
	`currency` enum('NGN','KES','ZAR','USD','USDC','USDT') NOT NULL,
	`accountKind` enum('liquidity_pool','nostro','vostro','prefunding','custody_wallet') NOT NULL,
	`accountReference` varchar(255) NOT NULL,
	`availableAmount` decimal(30,12) NOT NULL,
	`reservedAmount` decimal(30,12) NOT NULL DEFAULT '0',
	`sourceReference` varchar(512) NOT NULL,
	`reconciledAt` datetime NOT NULL,
	`recordedBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `liquidityPositions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `marketObservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`integrationConnectionId` int NOT NULL,
	`baseAsset` enum('NGN','KES','ZAR','USD','USDC','USDT') NOT NULL,
	`quoteAsset` enum('NGN','KES','ZAR','USD','USDC','USDT') NOT NULL,
	`rate` decimal(30,12) NOT NULL,
	`observedAt` datetime NOT NULL,
	`sourceReference` varchar(2048) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `marketObservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paymentOrders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`customerId` int NOT NULL,
	`beneficiaryId` int NOT NULL,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR') NOT NULL,
	`sourceCurrency` enum('NGN','KES','ZAR','USD','USDC','USDT') NOT NULL,
	`sourceAmount` decimal(30,12) NOT NULL,
	`targetCurrency` enum('NGN','KES','ZAR','USD','USDC','USDT') NOT NULL,
	`targetAmount` decimal(30,12),
	`status` enum('draft','pending_policy_decision','blocked','manual_review','approved','executing','partially_completed','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
	`policyDecisionReference` varchar(255),
	`providerFinalityReference` varchar(512),
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `paymentOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `paymentOrders_idempotencyKey_unique` UNIQUE(`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `regulatoryReports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`regulator` enum('CBN','CBK','SARB') NOT NULL,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR') NOT NULL,
	`reportType` varchar(255) NOT NULL,
	`periodStart` datetime NOT NULL,
	`periodEnd` datetime NOT NULL,
	`status` enum('draft','validated','pending_submission','submitted','rejected','submission_unavailable') NOT NULL DEFAULT 'draft',
	`artifactUrl` varchar(2048),
	`evidenceManifest` json,
	`submissionReference` varchar(512),
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `regulatoryReports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
UPDATE `users` SET `role` = 'auditor' WHERE `role` = 'user';--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('admin','compliance_officer','treasury_operator','auditor') NOT NULL DEFAULT 'auditor';--> statement-breakpoint
CREATE INDEX `activity_object_idx` ON `activityEvents` (`objectType`,`objectId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `compliance_case_status_idx` ON `complianceCases` (`status`,`severity`,`openedAt`);--> statement-breakpoint
CREATE INDEX `liquidity_corridor_idx` ON `liquidityPositions` (`corridor`,`currency`,`reconciledAt`);--> statement-breakpoint
CREATE INDEX `market_pair_idx` ON `marketObservations` (`baseAsset`,`quoteAsset`,`observedAt`);--> statement-breakpoint
CREATE INDEX `payment_corridor_status_idx` ON `paymentOrders` (`corridor`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `regulatory_report_idx` ON `regulatoryReports` (`regulator`,`corridor`,`periodEnd`); 
