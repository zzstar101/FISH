CREATE TYPE "public"."message_visibility" AS ENUM('DELIVERED', 'PENDING_REVIEW', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."chat_moderation_kind" AS ENUM('TEXT', 'IMAGE', 'VOICE');--> statement-breakpoint
CREATE TYPE "public"."chat_moderation_status" AS ENUM('PENDING', 'SETTLED');--> statement-breakpoint
CREATE TABLE "chat_moderation_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"kind" "chat_moderation_kind" NOT NULL,
	"decision" "moderation_decision" NOT NULL,
	"machine_decision" "moderation_decision" NOT NULL,
	"status" "chat_moderation_status" NOT NULL,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"policy_version" text NOT NULL,
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
	CONSTRAINT "chat_moderation_records_provider_known" CHECK ("chat_moderation_records"."provider" IN ('LOCAL', 'TENCENT_TMS', 'TENCENT_IMS')),
	CONSTRAINT "chat_moderation_records_suggestion_known" CHECK ("chat_moderation_records"."suggestion" IS NULL OR "chat_moderation_records"."suggestion" IN ('Pass', 'Review', 'Block')),
	CONSTRAINT "chat_moderation_records_score_range" CHECK ("chat_moderation_records"."score" IS NULL OR ("chat_moderation_records"."score" >= 0 AND "chat_moderation_records"."score" <= 100))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "visibility" "message_visibility" DEFAULT 'DELIVERED' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_moderation_records" ADD CONSTRAINT "chat_moderation_records_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_moderation_records" ADD CONSTRAINT "chat_moderation_records_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_moderation_records" ADD CONSTRAINT "chat_moderation_records_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_moderation_records" ADD CONSTRAINT "chat_moderation_records_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_moderation_records_message_id_uq" ON "chat_moderation_records" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_moderation_records_status_created_at_idx" ON "chat_moderation_records" USING btree ("status","created_at");