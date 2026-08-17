CREATE TABLE `scheduledJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purpose` enum('regulatory_deadline_reminders') NOT NULL,
	`scheduleCronTaskUid` varchar(65),
	`cronExpression` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`lastExecutedAt` timestamp,
	`createdBy` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `scheduledJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `scheduledJobs_purpose_unique` UNIQUE(`purpose`),
	CONSTRAINT `scheduledJobs_scheduleCronTaskUid_unique` UNIQUE(`scheduleCronTaskUid`)
);
--> statement-breakpoint
CREATE INDEX `scheduled_job_task_idx` ON `scheduledJobs` (`scheduleCronTaskUid`);