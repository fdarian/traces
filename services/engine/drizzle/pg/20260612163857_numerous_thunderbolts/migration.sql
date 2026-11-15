CREATE TABLE "ingest_state" (
	"service" text PRIMARY KEY NOT NULL,
	"cursorEnd" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"service" text NOT NULL,
	"exceptionType" text NOT NULL,
	"status" text NOT NULL,
	"firstSeen" timestamp NOT NULL,
	"lastSeen" timestamp NOT NULL,
	"occurrenceCount" integer NOT NULL,
	"resolvedAt" timestamp,
	CONSTRAINT "issues_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "occurrences" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issueId" bigint NOT NULL,
	"traceId" text NOT NULL,
	"spanId" text NOT NULL,
	"serviceName" text NOT NULL,
	"timestamp" timestamp NOT NULL,
	"exceptionMessage" text NOT NULL,
	"exceptionStacktrace" text,
	"attributes" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_issueId_issues_id_fk" FOREIGN KEY ("issueId") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_status_idx" ON "issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX "issues_service_idx" ON "issues" USING btree ("service");--> statement-breakpoint
CREATE INDEX "issues_last_seen_idx" ON "issues" USING btree ("lastSeen");--> statement-breakpoint
CREATE INDEX "occurrences_issue_id_idx" ON "occurrences" USING btree ("issueId");--> statement-breakpoint
CREATE INDEX "occurrences_timestamp_idx" ON "occurrences" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "occurrences_issue_span_idx" ON "occurrences" USING btree ("issueId","spanId");