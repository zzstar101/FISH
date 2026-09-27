CREATE TABLE "listing_media_objects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"staging_key" text NOT NULL,
	"final_key" text,
	"content_digest" text NOT NULL,
	"provider_md5" text,
	"moderation_decision" "moderation_decision" NOT NULL,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_media_objects_staging_key_prefix" CHECK ("listing_media_objects"."staging_key" LIKE 'listing-media/%'),
	CONSTRAINT "listing_media_objects_content_digest_sha256" CHECK ("listing_media_objects"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "listing_media_objects_provider_md5_shape" CHECK ("listing_media_objects"."provider_md5" IS NULL OR "listing_media_objects"."provider_md5" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "listing_media_objects_final_key_required" CHECK (("listing_media_objects"."moderation_decision" = 'BLOCK') OR ("listing_media_objects"."final_key" IS NOT NULL)),
	CONSTRAINT "listing_media_objects_provider_known" CHECK ("listing_media_objects"."provider" IN ('LOCAL', 'TENCENT_IMS'))
);
--> statement-breakpoint
ALTER TABLE "listing_media_objects" ADD CONSTRAINT "listing_media_objects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_media_objects_idempotency_uq" ON "listing_media_objects" USING btree ("user_id","staging_key","content_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_media_objects_final_key_uq" ON "listing_media_objects" USING btree ("final_key");--> statement-breakpoint
CREATE INDEX "listing_media_objects_user_id_created_at_idx" ON "listing_media_objects" USING btree ("user_id","created_at");