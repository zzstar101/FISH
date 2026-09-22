ALTER TABLE "transaction_meetup_tokens" DROP CONSTRAINT "transaction_meetup_tokens_expires_after_issued";--> statement-breakpoint
ALTER TABLE "transaction_meetup_tokens" DROP COLUMN "expires_at";