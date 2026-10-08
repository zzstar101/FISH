CREATE TYPE "public"."feedback_status" AS ENUM('PENDING', 'REPLIED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."feedback_type" AS ENUM('BUG', 'UX', 'DISPUTE', 'REPORT', 'ACCOUNT', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'FEEDBACK_DECISION' BEFORE 'LISTING_DELISTED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'FEEDBACK' BEFORE 'USER_RESTRICTION';--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"type" "feedback_type" NOT NULL,
	"content" text NOT NULL,
	"contact" text,
	"status" "feedback_status" DEFAULT 'PENDING' NOT NULL,
	"reply" text,
	"handling_note" text,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_user_client_request_uidx" ON "feedback" USING btree ("user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "feedback_status_created_at_idx" ON "feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_user_created_at_idx" ON "feedback" USING btree ("user_id","created_at");