ALTER TYPE "public"."admin_audit_action" ADD VALUE 'PROFILE_MODERATION_DECISION';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'PROFILE_MODERATION_RECORD';--> statement-breakpoint
CREATE TABLE "profile_moderation_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
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
	CONSTRAINT "profile_moderation_status_check" CHECK ("profile_moderation_records"."status" IN ('PENDING', 'SETTLED')),
	CONSTRAINT "profile_moderation_provider_check" CHECK ("profile_moderation_records"."provider" IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS')),
	CONSTRAINT "profile_moderation_suggestion_check" CHECK ("profile_moderation_records"."suggestion" IN ('Pass', 'Review', 'Block')),
	CONSTRAINT "profile_moderation_decision_check" CHECK ("profile_moderation_records"."decision" IN ('ALLOW', 'BLOCK', 'REVIEW')),
	CONSTRAINT "profile_moderation_score_check" CHECK ("profile_moderation_records"."score" IS NULL OR ("profile_moderation_records"."score" >= 0 AND "profile_moderation_records"."score" <= 100))
);
--> statement-breakpoint
ALTER TABLE "profile_moderation_records" ADD CONSTRAINT "profile_moderation_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_moderation_records" ADD CONSTRAINT "profile_moderation_records_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_moderation_pending_user_uq" ON "profile_moderation_records" USING btree ("user_id") WHERE "profile_moderation_records"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "profile_moderation_status_created_at_idx" ON "profile_moderation_records" USING btree ("status","created_at");