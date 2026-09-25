CREATE TABLE "login_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_hash" text NOT NULL,
	"verifier_hash" text NOT NULL,
	"bound_user_id" uuid,
	"bound_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_tickets" ADD CONSTRAINT "login_tickets_bound_user_id_users_id_fk" FOREIGN KEY ("bound_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_tickets_ticket_hash_uq" ON "login_tickets" USING btree ("ticket_hash");--> statement-breakpoint
CREATE INDEX "login_tickets_expires_at_idx" ON "login_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "login_tickets_bound_user_id_idx" ON "login_tickets" USING btree ("bound_user_id");