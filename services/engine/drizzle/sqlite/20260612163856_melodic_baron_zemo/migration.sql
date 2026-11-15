CREATE TABLE `ingest_state` (
	`service` text PRIMARY KEY NOT NULL,
	`cursorEnd` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`service` text NOT NULL,
	`exceptionType` text NOT NULL,
	`status` text NOT NULL,
	`firstSeen` integer NOT NULL,
	`lastSeen` integer NOT NULL,
	`occurrenceCount` integer NOT NULL,
	`resolvedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_fingerprint_unique` ON `issues` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `issues_status_idx` ON `issues` (`status`);--> statement-breakpoint
CREATE INDEX `issues_service_idx` ON `issues` (`service`);--> statement-breakpoint
CREATE INDEX `issues_last_seen_idx` ON `issues` (`lastSeen`);--> statement-breakpoint
CREATE TABLE `occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issueId` integer NOT NULL,
	`traceId` text NOT NULL,
	`spanId` text NOT NULL,
	`serviceName` text NOT NULL,
	`timestamp` integer NOT NULL,
	`exceptionMessage` text NOT NULL,
	`exceptionStacktrace` text,
	`attributes` text NOT NULL,
	FOREIGN KEY (`issueId`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `occurrences_issue_id_idx` ON `occurrences` (`issueId`);--> statement-breakpoint
CREATE INDEX `occurrences_timestamp_idx` ON `occurrences` (`timestamp`);--> statement-breakpoint
CREATE INDEX `occurrences_issue_span_idx` ON `occurrences` (`issueId`,`spanId`);