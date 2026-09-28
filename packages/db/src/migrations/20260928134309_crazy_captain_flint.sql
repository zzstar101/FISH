CREATE TYPE "public"."transaction_review_rating" AS ENUM('POSITIVE', 'NEUTRAL', 'NEGATIVE');--> statement-breakpoint
CREATE TABLE "favorites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"follower_id" uuid NOT NULL,
	"following_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_no_self_follow" CHECK ("follows"."follower_id" <> "follows"."following_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_review_images" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"review_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_review_images_sort_order_non_negative" CHECK ("transaction_review_images"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transaction_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"rating" "transaction_review_rating" NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_id_users_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_review_images" ADD CONSTRAINT "transaction_review_images_review_id_transaction_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."transaction_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_reviews" ADD CONSTRAINT "transaction_reviews_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_reviews" ADD CONSTRAINT "transaction_reviews_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_user_id_listing_id_uq" ON "favorites" USING btree ("user_id","listing_id");--> statement-breakpoint
CREATE INDEX "favorites_user_id_created_at_id_idx" ON "favorites" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "follows_follower_id_following_id_uq" ON "follows" USING btree ("follower_id","following_id");--> statement-breakpoint
CREATE INDEX "follows_follower_id_created_at_id_idx" ON "follows" USING btree ("follower_id","created_at","id");--> statement-breakpoint
CREATE INDEX "follows_following_id_created_at_id_idx" ON "follows" USING btree ("following_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_review_images_review_id_sort_order_uq" ON "transaction_review_images" USING btree ("review_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_reviews_transaction_id_author_id_uq" ON "transaction_reviews" USING btree ("transaction_id","author_id");--> statement-breakpoint
CREATE INDEX "transaction_reviews_author_id_created_at_id_idx" ON "transaction_reviews" USING btree ("author_id","created_at","id");