ALTER TABLE "messages" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_request_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_conversation_client_request_uq" ON "messages" USING btree ("sender_id","conversation_id","client_request_id") WHERE "messages"."client_request_id" IS NOT NULL;