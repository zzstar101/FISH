CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."listing_category" AS ENUM('DIGITAL', 'BOOKS', 'BEAUTY', 'DAILY', 'SPORTS', 'APPAREL', 'TRANSPORT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."listing_condition" AS ENUM('NEW', 'LIKE_NEW', 'GOOD', 'FAIR');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('TEXT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('PENDING_MEETUP', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."auth_status" AS ENUM('UNVERIFIED', 'VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."wish_status" AS ENUM('ACTIVE', 'FULFILLED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"buyer_last_read_at" timestamp with time zone,
	"seller_last_read_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_buyer_id_differs_from_seller_id" CHECK ("conversations"."buyer_id" <> "conversations"."seller_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_attempts_non_negative" CHECK ("jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "listing_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_images_sort_order_non_negative" CHECK ("listing_images"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"price_cents" integer NOT NULL,
	"category" "listing_category" NOT NULL,
	"condition" "listing_condition" NOT NULL,
	"status" "listing_status" DEFAULT 'ACTIVE' NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"negotiable" boolean DEFAULT false NOT NULL,
	"free" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_id_seller_id_uq" UNIQUE("id","seller_id"),
	CONSTRAINT "listings_price_cents_non_negative" CHECK ("listings"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"wish_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"category_score" smallint NOT NULL,
	"keyword_score" smallint NOT NULL,
	"price_score" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_score_range" CHECK ("matches"."score" >= 0 AND "matches"."score" <= 100),
	CONSTRAINT "matches_category_score_range" CHECK ("matches"."category_score" >= 0 AND "matches"."category_score" <= 100),
	CONSTRAINT "matches_keyword_score_range" CHECK ("matches"."keyword_score" >= 0 AND "matches"."keyword_score" <= 100),
	CONSTRAINT "matches_price_score_range" CHECK ("matches"."price_score" >= 0 AND "matches"."price_score" <= 100)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid,
	"type" "message_type" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_text_requires_sender" CHECK ("messages"."type" <> 'TEXT' OR "messages"."sender_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "transaction_status" DEFAULT 'PENDING_MEETUP' NOT NULL,
	"buyer_confirmed_at" timestamp with time zone,
	"seller_confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_amount_cents_non_negative" CHECK ("transactions"."amount_cents" >= 0),
	CONSTRAINT "transactions_buyer_id_differs_from_seller_id" CHECK ("transactions"."buyer_id" <> "transactions"."seller_id"),
	CONSTRAINT "transactions_completed_at_matches_status" CHECK (("transactions"."status" = 'COMPLETED') = ("transactions"."completed_at" IS NOT NULL)),
	CONSTRAINT "transactions_cancelled_at_matches_status" CHECK (("transactions"."status" = 'CANCELLED') = ("transactions"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_no" text NOT NULL,
	"password_hash" text NOT NULL,
	"nickname" text NOT NULL,
	"avatar_url" text,
	"campus" text,
	"auth_status" "auth_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_student_no_unique" UNIQUE("student_no")
);
--> statement-breakpoint
CREATE TABLE "wishes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	"category" "listing_category",
	"budget_min_cents" integer,
	"budget_max_cents" integer,
	"description" text,
	"accept_similar" boolean DEFAULT true NOT NULL,
	"status" "wish_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishes_budget_min_cents_non_negative" CHECK ("wishes"."budget_min_cents" IS NULL OR "wishes"."budget_min_cents" >= 0),
	CONSTRAINT "wishes_budget_max_cents_non_negative" CHECK ("wishes"."budget_max_cents" IS NULL OR "wishes"."budget_max_cents" >= 0),
	CONSTRAINT "wishes_budget_range_ordered" CHECK ("wishes"."budget_min_cents" IS NULL OR "wishes"."budget_max_cents" IS NULL OR "wishes"."budget_min_cents" <= "wishes"."budget_max_cents")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_listing_id_seller_id_fk" FOREIGN KEY ("listing_id","seller_id") REFERENCES "public"."listings"("id","seller_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_wish_id_wishes_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."wishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_listing_id_seller_id_fk" FOREIGN KEY ("listing_id","seller_id") REFERENCES "public"."listings"("id","seller_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishes" ADD CONSTRAINT "wishes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_listing_id_buyer_id_uq" ON "conversations" USING btree ("listing_id","buyer_id");--> statement-breakpoint
CREATE INDEX "conversations_buyer_id_last_message_at_idx" ON "conversations" USING btree ("buyer_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_seller_id_last_message_at_idx" ON "conversations" USING btree ("seller_id","last_message_at");--> statement-breakpoint
CREATE INDEX "jobs_status_run_at_id_idx" ON "jobs" USING btree ("status","run_at","id");--> statement-breakpoint
CREATE INDEX "jobs_running_locked_at_idx" ON "jobs" USING btree ("locked_at") WHERE "jobs"."status" = 'RUNNING';--> statement-breakpoint
CREATE UNIQUE INDEX "listing_images_listing_id_sort_order_uq" ON "listing_images" USING btree ("listing_id","sort_order");--> statement-breakpoint
CREATE INDEX "listings_status_created_at_idx" ON "listings" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "listings_category_price_cents_idx" ON "listings" USING btree ("category","price_cents");--> statement-breakpoint
CREATE INDEX "listings_seller_id_status_idx" ON "listings" USING btree ("seller_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_listing_id_wish_id_uq" ON "matches" USING btree ("listing_id","wish_id");--> statement-breakpoint
CREATE INDEX "matches_wish_id_score_idx" ON "matches" USING btree ("wish_id","score");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_id_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_listing_id_live_uq" ON "transactions" USING btree ("listing_id") WHERE "transactions"."status" IN ('PENDING_MEETUP', 'COMPLETED');--> statement-breakpoint
CREATE INDEX "wishes_status_category_idx" ON "wishes" USING btree ("status","category");--> statement-breakpoint
CREATE INDEX "wishes_user_id_status_idx" ON "wishes" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "wishes_category_budget_max_cents_idx" ON "wishes" USING btree ("category","budget_max_cents");