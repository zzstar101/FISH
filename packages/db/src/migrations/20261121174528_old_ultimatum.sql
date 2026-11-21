CREATE TYPE "public"."moderation_model_review_decision" AS ENUM('PASS', 'BLOCK', 'UNSURE', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."moderation_model_review_outcome" AS ENUM('SHADOW', 'AUTO_PASSED', 'AUTO_REJECTED', 'PENDING');--> statement-breakpoint
CREATE TABLE "moderation_model_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"listing_id" uuid NOT NULL,
	"moderation_record_id" uuid,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_digest" text NOT NULL,
	"decision" "moderation_model_review_decision" NOT NULL,
	"category" text,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"confidence" double precision,
	"latency_ms" integer NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"outcome" "moderation_model_review_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_model_reviews_confidence_range" CHECK ("moderation_model_reviews"."confidence" IS NULL OR ("moderation_model_reviews"."confidence" >= 0 AND "moderation_model_reviews"."confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "listing_media_objects" ADD COLUMN "provider_label" text;--> statement-breakpoint
ALTER TABLE "listing_media_objects" ADD COLUMN "provider_sub_label" text;--> statement-breakpoint
ALTER TABLE "moderation_model_reviews" ADD CONSTRAINT "moderation_model_reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_model_reviews" ADD CONSTRAINT "moderation_model_reviews_moderation_record_id_listing_moderation_records_id_fk" FOREIGN KEY ("moderation_record_id") REFERENCES "public"."listing_moderation_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_model_reviews_listing_prompt_model_uq" ON "moderation_model_reviews" USING btree ("listing_id","prompt_version","model","input_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_listing_moderation_listing_id_pending_uidx" ON "jobs" USING btree (("payload"->>'listingId')) WHERE "jobs"."type" = 'LISTING_MODERATION' AND "jobs"."status" = 'PENDING';