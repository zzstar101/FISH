CREATE TABLE "listing_view_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"last_viewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_view_history" ADD CONSTRAINT "listing_view_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_view_history" ADD CONSTRAINT "listing_view_history_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_view_history_user_id_listing_id_uq" ON "listing_view_history" USING btree ("user_id","listing_id");--> statement-breakpoint
CREATE INDEX "listing_view_history_user_id_last_viewed_at_id_idx" ON "listing_view_history" USING btree ("user_id","last_viewed_at","id");