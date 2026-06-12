DROP INDEX "occurrences_issue_span_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_issue_trace_span_unique" ON "occurrences" USING btree ("issueId","traceId","spanId");