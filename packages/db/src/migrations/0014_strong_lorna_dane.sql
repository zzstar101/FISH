CREATE TABLE "ai_polish_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"candidate_count" integer,
	"filtered_count" integer,
	"latency_ms" integer,
	"model" text,
	"prompt_version" text,
	"input_chars" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer
);
--> statement-breakpoint
ALTER TABLE "ai_polish_requests" ADD CONSTRAINT "ai_polish_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_polish_requests_user_id_created_at_idx" ON "ai_polish_requests" USING btree ("user_id","created_at");