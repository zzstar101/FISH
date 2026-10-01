ALTER TABLE "listing_moderation_records" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD COLUMN "suggestion" text;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD COLUMN "sub_label" text;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD COLUMN "score" double precision;--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD CONSTRAINT "listing_moderation_records_provider_known" CHECK ("listing_moderation_records"."provider" IS NULL OR "listing_moderation_records"."provider" IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS', 'MANUAL'));--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD CONSTRAINT "listing_moderation_records_suggestion_known" CHECK ("listing_moderation_records"."suggestion" IS NULL OR "listing_moderation_records"."suggestion" IN ('Pass', 'Review', 'Block'));--> statement-breakpoint
ALTER TABLE "listing_moderation_records" ADD CONSTRAINT "listing_moderation_records_score_range" CHECK ("listing_moderation_records"."score" IS NULL OR ("listing_moderation_records"."score" >= 0 AND "listing_moderation_records"."score" <= 100));