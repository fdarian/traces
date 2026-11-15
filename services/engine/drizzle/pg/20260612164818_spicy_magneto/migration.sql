DROP INDEX "occurrences_issue_span_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "occurrences_issue_span_unique" ON "occurrences" USING btree ("issueId","spanId");