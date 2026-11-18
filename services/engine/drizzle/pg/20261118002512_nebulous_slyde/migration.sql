CREATE TABLE "service_error_traces" (
	"service" text,
	"traceId" text,
	"startMs" bigint NOT NULL,
	"rootService" text NOT NULL,
	"rootOperation" text NOT NULL,
	"spanCount" integer NOT NULL,
	"errorSpanCount" integer NOT NULL,
	"durationMs" double precision NOT NULL,
	CONSTRAINT "service_error_traces_pkey" PRIMARY KEY("service","traceId")
);
--> statement-breakpoint
CREATE TABLE "service_stat_buckets" (
	"resolution" text,
	"bucketStart" bigint,
	"service" text,
	"traceCount" integer NOT NULL,
	"errorTraceCount" integer NOT NULL,
	"latency" text NOT NULL,
	CONSTRAINT "service_stat_buckets_pkey" PRIMARY KEY("resolution","bucketStart","service")
);
--> statement-breakpoint
CREATE TABLE "service_stat_cursors" (
	"service" text PRIMARY KEY,
	"startedMs" bigint NOT NULL,
	"forwardMs" bigint NOT NULL,
	"updatedMs" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_stat_gaps" (
	"id" bigserial PRIMARY KEY,
	"service" text NOT NULL,
	"startMs" bigint NOT NULL,
	"endMs" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_stat_seen" (
	"service" text,
	"traceId" text,
	"countedMs" bigint NOT NULL,
	CONSTRAINT "service_stat_seen_pkey" PRIMARY KEY("service","traceId")
);
--> statement-breakpoint
CREATE INDEX "service_error_traces_service_start_idx" ON "service_error_traces" ("service","startMs");--> statement-breakpoint
CREATE INDEX "service_stat_gaps_service_end_idx" ON "service_stat_gaps" ("service","endMs");--> statement-breakpoint
CREATE INDEX "service_stat_seen_counted_idx" ON "service_stat_seen" ("countedMs");