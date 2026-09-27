CREATE TYPE "public"."user_restriction_status" AS ENUM('ACTIVE', 'LIFTED');--> statement-breakpoint
CREATE TYPE "public"."user_restriction_type" AS ENUM('PUBLISH_RESTRICT', 'BAN');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('MISLEADING', 'PROHIBITED', 'FRAUD', 'SPAM', 'HARASSMENT', 'IMPERSONATION', 'ABUSE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('PENDING', 'HANDLED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('LISTING', 'USER');--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'REPORT_DECISION';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'LISTING_DELISTED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'LISTING_RESTORED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'USER_RESTRICTED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'USER_RESTRICTION_LIFTED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'USER_BANNED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE 'USER_UNBANNED';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'REPORT';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_target_type" ADD VALUE 'USER_RESTRICTION';--> statement-breakpoint
CREATE TABLE "user_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "user_restriction_type" NOT NULL,
	"status" "user_restriction_status" DEFAULT 'ACTIVE' NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"source_report_id" uuid,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_restrictions_no_self_restrict" CHECK ("user_restrictions"."user_id" <> "user_restrictions"."actor_user_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
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
ALTER TABLE "listings" ADD COLUMN "governance_delisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_source_report_id_reports_id_fk" FOREIGN KEY ("source_report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_restrictions_user_type_status_idx" ON "user_restrictions" USING btree ("user_id","type","status");--> statement-breakpoint
CREATE INDEX "user_restrictions_status_created_at_idx" ON "user_restrictions" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_restrictions_active_user_type_uidx" ON "user_restrictions" USING btree ("user_id","type") WHERE "user_restrictions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "reports_pending_reporter_target_uidx" ON "reports" USING btree ("reporter_id","target_type","target_id") WHERE "reports"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "reports_status_created_at_idx" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_reporter_created_at_idx" ON "reports" USING btree ("reporter_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_target_created_at_idx" ON "reports" USING btree ("target_type","target_id","created_at");