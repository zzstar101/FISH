CREATE TABLE "listing_lookup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "listing_lookup_attempts_subject_time_idx" ON "listing_lookup_attempts" USING btree ("subject_type","subject_key","created_at");