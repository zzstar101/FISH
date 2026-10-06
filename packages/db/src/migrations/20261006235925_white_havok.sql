CREATE TYPE "public"."dispute_resolution" AS ENUM('UPHELD', 'DISMISSED', 'INCONCLUSIVE');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('PENDING', 'RESOLVED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."dispute_type" AS ENUM('ITEM_MISMATCH', 'NOT_COMPLETED', 'PAYMENT_ISSUE', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'DISPUTE_DECISION' BEFORE 'LISTING_DELISTED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'DISPUTE' BEFORE 'USER_RESTRICTION';--> statement-breakpoint
CREATE TABLE "dispute_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispute_attachments_size_bytes_positive" CHECK ("dispute_attachments"."size_bytes" > 0),
	CONSTRAINT "dispute_attachments_dimensions_positive" CHECK ("dispute_attachments"."width" > 0 AND "dispute_attachments"."height" > 0),
	CONSTRAINT "dispute_attachments_key_prefix" CHECK ("dispute_attachments"."object_key" LIKE 'dispute-media/%'),
	CONSTRAINT "dispute_attachments_digest_sha256" CHECK ("dispute_attachments"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "dispute_attachments_mime_allowed" CHECK ("dispute_attachments"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
CREATE TABLE "dispute_evidence_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"initiator_id" uuid NOT NULL,
	"respondent_id" uuid NOT NULL,
	"type" "dispute_type" NOT NULL,
	"detail_text" text,
	"status" "dispute_status" DEFAULT 'PENDING' NOT NULL,
	"resolution" "dispute_resolution",
	"resolution_note" text,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_initiator_id_differs_from_respondent_id" CHECK ("disputes"."initiator_id" <> "disputes"."respondent_id"),
	CONSTRAINT "disputes_other_type_requires_detail" CHECK ("disputes"."type" <> 'OTHER'
        OR ("disputes"."detail_text" IS NOT NULL AND length(btrim("disputes"."detail_text")) > 0)),
	CONSTRAINT "disputes_resolution_matches_status" CHECK (("disputes"."status" = 'RESOLVED') = ("disputes"."resolution" IS NOT NULL)
        AND ("disputes"."status" = 'RESOLVED') = ("disputes"."resolution_note" IS NOT NULL)
        AND ("disputes"."status" = 'RESOLVED') = ("disputes"."handled_by" IS NOT NULL)
        AND ("disputes"."status" = 'RESOLVED') = ("disputes"."handled_at" IS NOT NULL)),
	CONSTRAINT "disputes_withdrawn_at_matches_status" CHECK (("disputes"."status" = 'WITHDRAWN') = ("disputes"."withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_attachments" ADD CONSTRAINT "dispute_attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_evidence_messages" ADD CONSTRAINT "dispute_evidence_messages_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_evidence_messages" ADD CONSTRAINT "dispute_evidence_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_evidence_messages" ADD CONSTRAINT "dispute_evidence_messages_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_respondent_id_users_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_attachments_object_key_uq" ON "dispute_attachments" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "dispute_attachments_dispute_created_at_idx" ON "dispute_attachments" USING btree ("dispute_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_evidence_messages_dispute_message_uq" ON "dispute_evidence_messages" USING btree ("dispute_id","message_id");--> statement-breakpoint
CREATE INDEX "dispute_evidence_messages_dispute_created_at_idx" ON "dispute_evidence_messages" USING btree ("dispute_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_pending_transaction_initiator_uq" ON "disputes" USING btree ("transaction_id","initiator_id") WHERE "disputes"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "disputes_initiator_created_at_idx" ON "disputes" USING btree ("initiator_id","created_at","id");--> statement-breakpoint
CREATE INDEX "disputes_respondent_created_at_idx" ON "disputes" USING btree ("respondent_id","created_at","id");--> statement-breakpoint
CREATE INDEX "disputes_status_created_at_idx" ON "disputes" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "disputes_transaction_id_idx" ON "disputes" USING btree ("transaction_id");