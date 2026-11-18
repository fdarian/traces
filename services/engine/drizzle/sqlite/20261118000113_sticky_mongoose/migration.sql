CREATE TABLE `service_error_traces` (
	`service` text NOT NULL,
	`traceId` text NOT NULL,
	`startMs` integer NOT NULL,
	`rootService` text NOT NULL,
	`rootOperation` text NOT NULL,
	`spanCount` integer NOT NULL,
	`errorSpanCount` integer NOT NULL,
	`durationMs` real NOT NULL,
	CONSTRAINT `service_error_traces_pk` PRIMARY KEY(`service`, `traceId`)
);
--> statement-breakpoint
CREATE TABLE `service_stat_buckets` (
	`resolution` text NOT NULL,
	`bucketStart` integer NOT NULL,
	`service` text NOT NULL,
	`traceCount` integer NOT NULL,
	`errorTraceCount` integer NOT NULL,
	`latency` text NOT NULL,
	CONSTRAINT `service_stat_buckets_pk` PRIMARY KEY(`resolution`, `bucketStart`, `service`)
);
--> statement-breakpoint
CREATE TABLE `service_stat_cursors` (
	`service` text PRIMARY KEY,
	`startedMs` integer NOT NULL,
	`forwardMs` integer NOT NULL,
	`updatedMs` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_stat_gaps` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`service` text NOT NULL,
	`startMs` integer NOT NULL,
	`endMs` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_stat_seen` (
	`service` text NOT NULL,
	`traceId` text NOT NULL,
	`startMs` integer NOT NULL,
	CONSTRAINT `service_stat_seen_pk` PRIMARY KEY(`service`, `traceId`)
);
--> statement-breakpoint
CREATE INDEX `service_error_traces_service_start_idx` ON `service_error_traces` (`service`,`startMs`);--> statement-breakpoint
CREATE INDEX `service_stat_gaps_service_end_idx` ON `service_stat_gaps` (`service`,`endMs`);--> statement-breakpoint
CREATE INDEX `service_stat_seen_start_idx` ON `service_stat_seen` (`startMs`);