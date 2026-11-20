ALTER TYPE "public"."admin_audit_action" ADD VALUE 'REVIEW_MODERATION_DECISION';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'REVIEW_MODERATION_RECORD';--> statement-breakpoint
CREATE TABLE "review_moderation_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"staging_key" text NOT NULL,
	"final_key" text,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_digest" text NOT NULL,
	"provider_md5" text,
	"moderation_decision" "moderation_decision" NOT NULL,
	"settled_decision" "moderation_decision",
	"settled_at" timestamp with time zone,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"policy_version" text NOT NULL,
	"biz_type" text,
	"suggestion" text,
	"label" text,
	"sub_label" text,
	"score" double precision,
	"matched_rules" jsonb NOT NULL,
	"matched_terms_masked" jsonb NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_moderation_records_staging_key_prefix" CHECK ("review_moderation_records"."staging_key" LIKE 'transaction-review-media/%'),
	CONSTRAINT "review_moderation_records_content_digest_sha256" CHECK ("review_moderation_records"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_moderation_records_provider_md5_shape" CHECK ("review_moderation_records"."provider_md5" IS NULL OR "review_moderation_records"."provider_md5" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "review_moderation_records_size_positive" CHECK ("review_moderation_records"."size_bytes" > 0),
	CONSTRAINT "review_moderation_records_final_key_required" CHECK (("review_moderation_records"."moderation_decision" = 'BLOCK') OR ("review_moderation_records"."final_key" IS NOT NULL)),
	CONSTRAINT "review_moderation_records_final_key_prefix" CHECK ("review_moderation_records"."final_key" IS NULL
          OR "review_moderation_records"."final_key" LIKE 'reviews/%'
          OR "review_moderation_records"."final_key" LIKE 'review-moderation-media/%'),
	CONSTRAINT "review_moderation_records_provider_known" CHECK ("review_moderation_records"."provider" IN ('LOCAL', 'TENCENT_IMS')),
	CONSTRAINT "review_moderation_records_suggestion_known" CHECK ("review_moderation_records"."suggestion" IS NULL OR "review_moderation_records"."suggestion" IN ('Pass', 'Review', 'Block')),
	CONSTRAINT "review_moderation_records_score_range" CHECK ("review_moderation_records"."score" IS NULL OR ("review_moderation_records"."score" >= 0 AND "review_moderation_records"."score" <= 100)),
	CONSTRAINT "review_moderation_records_settled_pair" CHECK (("review_moderation_records"."settled_decision" IS NULL AND "review_moderation_records"."settled_at" IS NULL)
          OR ("review_moderation_records"."settled_decision" IS NOT NULL AND "review_moderation_records"."settled_at" IS NOT NULL)),
	CONSTRAINT "review_moderation_records_settled_review_only" CHECK ("review_moderation_records"."settled_decision" IS NULL OR "review_moderation_records"."moderation_decision" = 'REVIEW')
);
--> statement-breakpoint
ALTER TABLE "review_moderation_records" ADD CONSTRAINT "review_moderation_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_moderation_records" ADD CONSTRAINT "review_moderation_records_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_moderation_records" ADD CONSTRAINT "review_moderation_records_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_moderation_records_idempotency_uq" ON "review_moderation_records" USING btree ("user_id","staging_key","content_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "review_moderation_records_final_key_uq" ON "review_moderation_records" USING btree ("final_key");--> statement-breakpoint
CREATE INDEX "review_moderation_records_pending_idx" ON "review_moderation_records" USING btree ("settled_decision","moderation_decision","created_at");--> statement-breakpoint
CREATE INDEX "transaction_review_images_object_key_idx" ON "transaction_review_images" USING btree ("object_key");