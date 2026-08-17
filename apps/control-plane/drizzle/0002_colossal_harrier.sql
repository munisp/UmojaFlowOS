CREATE TABLE `notificationDeliveries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`alertPolicyId` int,
	`alertType` enum('liquidity_threshold','payment_failure','compliance_flag','regulatory_deadline') NOT NULL,
	`deliveryState` enum('accepted','unavailable') NOT NULL,
	`destination` varchar(64) NOT NULL,
	`correlationId` varchar(128) NOT NULL,
	`payloadHash` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notificationDeliveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paymentLegs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`paymentOrderId` int NOT NULL,
	`sequenceNumber` int NOT NULL,
	`legKind` enum('collection','fx','stablecoin_settlement','payout','reversal') NOT NULL,
	`counterpartyId` int,
	`status` enum('draft','pending_policy_decision','blocked','manual_review','approved','executing','partially_completed','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
	`providerInstructionReference` varchar(512),
	`providerFinalityReference` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paymentLegs_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_leg_sequence_idx` UNIQUE(`paymentOrderId`,`sequenceNumber`)
);
--> statement-breakpoint
CREATE TABLE `rateLocks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`marketObservationId` int NOT NULL,
	`paymentOrderId` int,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR') NOT NULL,
	`baseAsset` enum('NGN','KES','ZAR','USD','USDC','USDT') NOT NULL,
	`quoteAsset` enum('NGN','KES','ZAR','USD','USDC','USDT') NOT NULL,
	`lockedRate` decimal(30,12) NOT NULL,
	`expiresAt` datetime NOT NULL,
	`status` enum('locked','expired','cancelled') NOT NULL DEFAULT 'locked',
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rateLocks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `regulatoryDeadlines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`regulator` enum('CBN','CBK','SARB') NOT NULL,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR') NOT NULL,
	`title` varchar(255) NOT NULL,
	`dueAt` datetime NOT NULL,
	`sourceReference` varchar(2048) NOT NULL,
	`status` enum('open','acknowledged','completed','cancelled') NOT NULL DEFAULT 'open',
	`lastRemindedAt` timestamp,
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `regulatoryDeadlines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `notification_delivery_idx` ON `notificationDeliveries` (`alertType`,`createdAt`);--> statement-breakpoint
CREATE INDEX `rate_lock_status_idx` ON `rateLocks` (`corridor`,`status`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `regulatory_deadline_due_idx` ON `regulatoryDeadlines` (`status`,`dueAt`);