CREATE TABLE `kycDocuments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerId` int NOT NULL,
	`documentType` enum('registration_certificate','identity_document','proof_of_address','beneficial_ownership','source_of_funds','other') NOT NULL,
	`storageKey` varchar(1024) NOT NULL,
	`storageUrl` varchar(2048) NOT NULL,
	`originalFilename` varchar(512) NOT NULL,
	`mimeType` varchar(255) NOT NULL,
	`sizeBytes` int NOT NULL,
	`reviewStatus` enum('submitted','under_review','approved','rejected','expired') NOT NULL DEFAULT 'submitted',
	`reviewNote` text,
	`reviewedBy` varchar(64),
	`reviewedAt` timestamp,
	`uploadedBy` varchar(64) NOT NULL,
	`uploadedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `kycDocuments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sarStrFilings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`complianceCaseId` int NOT NULL,
	`corridor` enum('NIGERIA_NGN','KENYA_KES','SOUTH_AFRICA_ZAR') NOT NULL,
	`filingType` enum('sar','str') NOT NULL,
	`filingAuthority` varchar(255) NOT NULL,
	`sourceReference` varchar(2048) NOT NULL,
	`status` enum('draft','under_review','approved_for_submission','pending_submission','submitted','submission_unavailable','rejected') NOT NULL DEFAULT 'draft',
	`submissionReference` varchar(512),
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sarStrFilings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `kyc_document_customer_idx` ON `kycDocuments` (`customerId`,`reviewStatus`,`uploadedAt`);--> statement-breakpoint
CREATE INDEX `sar_str_filing_idx` ON `sarStrFilings` (`corridor`,`status`,`createdAt`);