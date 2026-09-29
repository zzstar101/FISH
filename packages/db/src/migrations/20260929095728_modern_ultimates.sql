CREATE TYPE "public"."recommendation_event_type" AS ENUM('IMPRESSION', 'DETAIL_VIEW', 'LONG_VIEW', 'IMAGE_VIEW', 'QUICK_SKIP', 'FAVORITE', 'UNFAVORITE', 'CHAT_START', 'COMMENT', 'TRANSACTION_START', 'PURCHASE', 'HIDE');--> statement-breakpoint
CREATE TYPE "public"."recommendation_source" AS ENUM('fresh', 'popular', 'semantic', 'wish', 'follow', 'similar', 'explore');--> statement-breakpoint
CREATE TABLE "recommendation_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"anonymous_session_id" uuid,
	"request_id" uuid,
	"listing_id" uuid NOT NULL,
	"event_type" "recommendation_event_type" NOT NULL,
	"position" integer,
	"source" "recommendation_source",
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_events_impression_requires_attribution" CHECK ("recommendation_events"."event_type" NOT IN ('IMPRESSION', 'QUICK_SKIP') OR ("recommendation_events"."request_id" IS NOT NULL AND "recommendation_events"."position" IS NOT NULL)),
	CONSTRAINT "recommendation_events_position_non_negative" CHECK ("recommendation_events"."position" IS NULL OR "recommendation_events"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recommendation_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"anonymous_session_id" uuid,
	"strategy_version" varchar(64) NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_requests_has_identity" CHECK ("recommendation_requests"."user_id" IS NOT NULL OR "recommendation_requests"."anonymous_session_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_requests" ADD CONSTRAINT "recommendation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_events_event_id_uq" ON "recommendation_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_events_impression_once_uq" ON "recommendation_events" USING btree ("request_id","listing_id","event_type") WHERE "recommendation_events"."event_type" IN ('IMPRESSION', 'QUICK_SKIP');--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_events_purchase_once_uq" ON "recommendation_events" USING btree ("listing_id") WHERE "recommendation_events"."event_type" = 'PURCHASE';--> statement-breakpoint
CREATE INDEX "recommendation_events_user_id_occurred_at_idx" ON "recommendation_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "recommendation_events_listing_id_occurred_at_idx" ON "recommendation_events" USING btree ("listing_id","occurred_at");--> statement-breakpoint
CREATE INDEX "recommendation_events_request_id_idx" ON "recommendation_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "recommendation_events_session_id_occurred_at_idx" ON "recommendation_events" USING btree ("anonymous_session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "recommendation_requests_user_id_requested_at_idx" ON "recommendation_requests" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE INDEX "recommendation_requests_session_id_requested_at_idx" ON "recommendation_requests" USING btree ("anonymous_session_id","requested_at");