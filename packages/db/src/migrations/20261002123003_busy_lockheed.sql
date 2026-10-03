CREATE TABLE "recommendation_request_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"request_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"listing_id" uuid NOT NULL,
	"primary_source" "recommendation_source" NOT NULL,
	"sources" "recommendation_source"[] NOT NULL,
	"rank_score" double precision NOT NULL,
	"rank_breakdown" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recommendation_request_items" ADD CONSTRAINT "recommendation_request_items_request_id_recommendation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."recommendation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_request_items" ADD CONSTRAINT "recommendation_request_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_request_items_position_uq" ON "recommendation_request_items" USING btree ("request_id","position");--> statement-breakpoint
CREATE INDEX "recommendation_request_items_request_id_idx" ON "recommendation_request_items" USING btree ("request_id");