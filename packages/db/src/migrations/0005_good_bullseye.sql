CREATE TABLE "campus_email_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "campus_email" text;--> statement-breakpoint
ALTER TABLE "campus_email_verifications" ADD CONSTRAINT "campus_email_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campus_email_verifications_email_sent_idx" ON "campus_email_verifications" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "campus_email_verifications_user_id_sent_idx" ON "campus_email_verifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_campus_email_uq" ON "users" USING btree ("campus_email");--> statement-breakpoint
-- #68：Mock Provider 时代的存量 VERIFIED 从未经过真实验证，统一重置。
-- 不变式：VERIFIED ⟺ campus_email 非空（验证成功事务同时写两者）。
UPDATE "users" SET "auth_status" = 'UNVERIFIED', "verified_at" = NULL;