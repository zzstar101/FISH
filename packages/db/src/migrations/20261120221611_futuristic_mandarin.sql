CREATE TYPE "public"."wish_moderation_status" AS ENUM('APPROVED', 'PENDING_REVIEW', 'REJECTED');--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'WISH_MODERATION_DECISION';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'WISH_MODERATION_RECORD';--> statement-breakpoint
CREATE TABLE "wish_moderation_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"wish_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"machine_decision" "moderation_decision" NOT NULL,
	"decision" "moderation_decision" NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"policy_version" text NOT NULL,
	"suggestion" text NOT NULL,
	"label" text,
	"sub_label" text,
	"score" integer,
	"matched_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_terms_masked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wish_moderation_status_check" CHECK ("wish_moderation_records"."status" IN ('PENDING', 'SETTLED')),
	CONSTRAINT "wish_moderation_provider_check" CHECK ("wish_moderation_records"."provider" IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS')),
	CONSTRAINT "wish_moderation_suggestion_check" CHECK ("wish_moderation_records"."suggestion" IN ('Pass', 'Review', 'Block')),
	CONSTRAINT "wish_moderation_decision_check" CHECK ("wish_moderation_records"."decision" IN ('ALLOW', 'BLOCK', 'REVIEW')),
	CONSTRAINT "wish_moderation_score_check" CHECK ("wish_moderation_records"."score" IS NULL OR ("wish_moderation_records"."score" >= 0 AND "wish_moderation_records"."score" <= 100))
);
--> statement-breakpoint
ALTER TABLE "wishes" ADD COLUMN "moderation_status" "wish_moderation_status" DEFAULT 'APPROVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "wishes" ADD COLUMN "content_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "wishes" ADD COLUMN "pending_keyword" text;--> statement-breakpoint
ALTER TABLE "wishes" ADD COLUMN "pending_description" text;--> statement-breakpoint
ALTER TABLE "wishes" ADD COLUMN "pending_version" integer;--> statement-breakpoint
ALTER TABLE "wish_moderation_records" ADD CONSTRAINT "wish_moderation_records_wish_id_wishes_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."wishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wish_moderation_records" ADD CONSTRAINT "wish_moderation_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wish_moderation_records" ADD CONSTRAINT "wish_moderation_records_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wish_moderation_pending_wish_content_version_uq" ON "wish_moderation_records" USING btree ("wish_id","content_version") WHERE "wish_moderation_records"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "wish_moderation_status_created_at_idx" ON "wish_moderation_records" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "wishes_moderation_status_idx" ON "wishes" USING btree ("moderation_status");