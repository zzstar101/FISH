CREATE TABLE "subscribe_message_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"page" text NOT NULL,
	"conversation_id" uuid,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_errcode" integer,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribe_message_deliveries_status_values" CHECK ("subscribe_message_deliveries"."status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'))
);
--> statement-breakpoint
CREATE TABLE "subscribe_message_grants" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"remaining" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribe_message_grants_user_id_kind_pk" PRIMARY KEY("user_id","kind"),
	CONSTRAINT "subscribe_message_grants_remaining_range" CHECK ("subscribe_message_grants"."remaining" >= 0 AND "subscribe_message_grants"."remaining" <= 50)
);
--> statement-breakpoint
ALTER TABLE "subscribe_message_deliveries" ADD CONSTRAINT "subscribe_message_deliveries_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribe_message_grants" ADD CONSTRAINT "subscribe_message_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscribe_message_deliveries_source_uq" ON "subscribe_message_deliveries" USING btree ("source_type","source_id","recipient_id");--> statement-breakpoint
CREATE INDEX "subscribe_message_deliveries_pending_idx" ON "subscribe_message_deliveries" USING btree ("next_attempt_at") WHERE "subscribe_message_deliveries"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "subscribe_message_deliveries_sending_idx" ON "subscribe_message_deliveries" USING btree ("updated_at") WHERE "subscribe_message_deliveries"."status" = 'SENDING';--> statement-breakpoint
CREATE INDEX "subscribe_message_deliveries_chat_throttle_idx" ON "subscribe_message_deliveries" USING btree ("conversation_id","recipient_id","created_at") WHERE "subscribe_message_deliveries"."source_type" = 'CHAT';