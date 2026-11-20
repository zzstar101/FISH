ALTER TYPE "public"."report_target_type" ADD VALUE 'MESSAGE';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'CHAT_MODERATION_DECISION';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'CHAT_MODERATION_RECORD';--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "evidence_snapshot" jsonb;