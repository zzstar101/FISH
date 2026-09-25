CREATE TYPE "public"."report_reason" AS ENUM('MISLEADING', 'PROHIBITED', 'FRAUD', 'SPAM', 'HARASSMENT', 'IMPERSONATION', 'ABUSE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('PENDING', 'HANDLED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('LISTING', 'USER');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"detail_text" text,
	"status" "report_status" DEFAULT 'PENDING' NOT NULL,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"handling_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_pending_reporter_target_uidx" ON "reports" USING btree ("reporter_id","target_type","target_id") WHERE "reports"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "reports_status_created_at_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_reporter_created_at_idx" ON "reports" USING btree ("reporter_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_target_created_at_idx" ON "reports" USING btree ("target_type","target_id","created_at");