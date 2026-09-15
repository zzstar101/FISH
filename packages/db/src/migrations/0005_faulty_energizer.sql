CREATE TYPE "public"."listing_moderation_status" AS ENUM('APPROVED', 'BLOCKED', 'REVIEW');--> statement-breakpoint
CREATE TYPE "public"."moderation_decision" AS ENUM('ALLOW', 'BLOCK', 'REVIEW');--> statement-breakpoint
CREATE TABLE "listing_moderation_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid,
	"seller_id" uuid NOT NULL,
	"action" text NOT NULL,
	"title_snapshot" text NOT NULL,
	"description_snapshot" text NOT NULL,
	"decision" "moderation_decision" NOT NULL,
	"matched_rules" jsonb NOT NULL,
	"matched_terms_masked" jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "moderation_status" "listing_moderation_status" DEFAULT 'APPROVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "moderation_reason" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "moderation_rule_version" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD CONSTRAINT "listing_moderation_records_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD CONSTRAINT "listing_moderation_records_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;