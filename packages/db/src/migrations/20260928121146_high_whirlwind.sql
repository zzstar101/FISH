ALTER TABLE "listing_media_objects" ADD COLUMN "settled_decision" "moderation_decision";--> statement-breakpoint
ALTER TABLE "listing_media_objects" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listing_media_objects" ADD CONSTRAINT "listing_media_objects_settled_pair" CHECK (("listing_media_objects"."settled_decision" IS NULL AND "listing_media_objects"."settled_at" IS NULL)
          OR ("listing_media_objects"."settled_decision" IS NOT NULL AND "listing_media_objects"."settled_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "listing_media_objects" ADD CONSTRAINT "listing_media_objects_settled_review_only" CHECK ("listing_media_objects"."settled_decision" IS NULL OR "listing_media_objects"."moderation_decision" = 'REVIEW');