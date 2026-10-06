CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'DELETION_REQUESTED', 'DELETED');--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'ACCOUNT_DELETION_COMPLETED';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_status" "account_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purge_scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_purge_scheduled_at_idx" ON "users" USING btree ("purge_scheduled_at") WHERE "users"."account_status" = 'DELETION_REQUESTED';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_deletion_timestamps_consistent" CHECK (("users"."account_status" = 'DELETION_REQUESTED') = ("users"."deletion_requested_at" IS NOT NULL AND "users"."purge_scheduled_at" IS NOT NULL));