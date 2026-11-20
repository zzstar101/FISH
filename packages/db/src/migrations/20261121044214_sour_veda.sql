CREATE TYPE "public"."legacy_media_audit_status" AS ENUM('PENDING', 'AUDITED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."legacy_media_public_visibility" AS ENUM('PUBLIC_DIRECT', 'LEGACY_PROXY', 'PRIVATE_PROXY', 'PRIVATE');--> statement-breakpoint
CREATE TYPE "public"."legacy_media_source_kind" AS ENUM('LISTING', 'REVIEW', 'CHAT');--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'LEGACY_MEDIA_AUDIT_DECISION';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'LEGACY_MEDIA_AUDIT_ITEM';--> statement-breakpoint
CREATE TABLE "legacy_media_audit_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"object_key" text NOT NULL,
	"source_kind" "legacy_media_source_kind" NOT NULL,
	"source_table" text NOT NULL,
	"source_refs" jsonb NOT NULL,
	"owner_user_id" uuid,
	"owner_count" integer DEFAULT 1 NOT NULL,
	"reference_count" integer DEFAULT 1 NOT NULL,
	"listing_reference_count" integer DEFAULT 0 NOT NULL,
	"public_visibility" "legacy_media_public_visibility" NOT NULL,
	"existing_decision" "moderation_decision",
	"audit_status" "legacy_media_audit_status" DEFAULT 'PENDING' NOT NULL,
	"decision" "moderation_decision",
	"provider" text,
	"provider_request_id" text,
	"policy_version" text,
	"suggestion" text,
	"label" text,
	"sub_label" text,
	"score" double precision,
	"content_digest" text,
	"size_bytes" integer,
	"mime_type" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"audited_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"inventory_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_media_audit_items_object_key_shape" CHECK (char_length("legacy_media_audit_items"."object_key") BETWEEN 1 AND 256),
	CONSTRAINT "legacy_media_audit_items_owner_count_positive" CHECK ("legacy_media_audit_items"."owner_count" >= 1),
	CONSTRAINT "legacy_media_audit_items_reference_count_consistent" CHECK ("legacy_media_audit_items"."reference_count" >= 1 AND "legacy_media_audit_items"."listing_reference_count" >= 0 AND "legacy_media_audit_items"."listing_reference_count" <= "legacy_media_audit_items"."reference_count"),
	CONSTRAINT "legacy_media_audit_items_provider_known" CHECK ("legacy_media_audit_items"."provider" IS NULL OR "legacy_media_audit_items"."provider" IN ('LOCAL', 'TENCENT_IMS')),
	CONSTRAINT "legacy_media_audit_items_suggestion_known" CHECK ("legacy_media_audit_items"."suggestion" IS NULL OR "legacy_media_audit_items"."suggestion" IN ('Pass', 'Review', 'Block')),
	CONSTRAINT "legacy_media_audit_items_score_range" CHECK ("legacy_media_audit_items"."score" IS NULL OR ("legacy_media_audit_items"."score" >= 0 AND "legacy_media_audit_items"."score" <= 100)),
	CONSTRAINT "legacy_media_audit_items_digest_shape" CHECK ("legacy_media_audit_items"."content_digest" IS NULL OR "legacy_media_audit_items"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_media_audit_items_audited_consistent" CHECK ("legacy_media_audit_items"."audit_status" <> 'AUDITED' OR ("legacy_media_audit_items"."decision" IS NOT NULL AND "legacy_media_audit_items"."audited_at" IS NOT NULL)),
	CONSTRAINT "legacy_media_audit_items_attempts_non_negative" CHECK ("legacy_media_audit_items"."attempts" >= 0),
	CONSTRAINT "legacy_media_audit_items_version_non_negative" CHECK ("legacy_media_audit_items"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "legacy_media_audit_items" ADD CONSTRAINT "legacy_media_audit_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_media_audit_items_object_key_uq" ON "legacy_media_audit_items" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "legacy_media_audit_items_status_next_attempt_idx" ON "legacy_media_audit_items" USING btree ("audit_status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "legacy_media_audit_items_source_kind_idx" ON "legacy_media_audit_items" USING btree ("source_kind");--> statement-breakpoint
CREATE INDEX "legacy_media_audit_items_owner_user_id_idx" ON "legacy_media_audit_items" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_legacy_media_audit_object_key_pending_uidx" ON "jobs" USING btree (("payload"->>'objectKey')) WHERE "jobs"."type" = 'LEGACY_MEDIA_AUDIT' AND "jobs"."status" = 'PENDING';