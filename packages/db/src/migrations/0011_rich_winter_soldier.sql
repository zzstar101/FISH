CREATE TABLE "transaction_meetup_tokens" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"code_hash" text NOT NULL,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by" uuid,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "transaction_meetup_tokens_consumed_by_matches_consumed_at" CHECK (("transaction_meetup_tokens"."consumed_at" IS NULL) = ("transaction_meetup_tokens"."consumed_by" IS NULL)),
	CONSTRAINT "transaction_meetup_tokens_expires_after_issued" CHECK ("transaction_meetup_tokens"."expires_at" > "transaction_meetup_tokens"."issued_at")
);
--> statement-breakpoint
ALTER TABLE "transaction_meetup_tokens" ADD CONSTRAINT "transaction_meetup_tokens_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_meetup_tokens" ADD CONSTRAINT "transaction_meetup_tokens_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_meetup_tokens" ADD CONSTRAINT "transaction_meetup_tokens_consumed_by_users_id_fk" FOREIGN KEY ("consumed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;