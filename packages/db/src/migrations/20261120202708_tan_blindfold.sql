CREATE TABLE "rate_limit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"bucket" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_events_lookup_idx" ON "rate_limit_events" USING btree ("bucket","subject","created_at");--> statement-breakpoint
CREATE INDEX "rate_limit_events_created_at_idx" ON "rate_limit_events" USING btree ("created_at");