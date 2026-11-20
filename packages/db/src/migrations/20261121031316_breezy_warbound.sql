ALTER TYPE "public"."admin_audit_action" ADD VALUE 'LEGACY_MEDIA_AUDIT_DECISION';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'LEGACY_MEDIA_AUDIT_ITEM';--> statement-breakpoint
ALTER TABLE "legacy_media_audit_items" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "legacy_media_audit_items" ADD CONSTRAINT "legacy_media_audit_items_version_non_negative" CHECK ("legacy_media_audit_items"."version" >= 0);