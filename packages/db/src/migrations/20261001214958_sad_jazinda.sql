CREATE TABLE "visual_search_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visual_search_attempts_subject_type_allowed" CHECK ("visual_search_attempts"."subject_type" in ('user', 'ip', 'session'))
);
--> statement-breakpoint
CREATE TABLE "listing_visual_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"listing_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"source_object_key" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_visual_embeddings_dimensions_matches_column" CHECK ("listing_visual_embeddings"."dimensions" = 1024),
	CONSTRAINT "listing_visual_embeddings_source_not_query_image" CHECK ("listing_visual_embeddings"."source_object_key" NOT LIKE 'visual-search/%')
);
--> statement-breakpoint
CREATE TABLE "visual_query_images" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"object_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visual_query_images_object_key_prefix" CHECK ("visual_query_images"."object_key" LIKE 'visual-search/%'),
	CONSTRAINT "visual_query_images_subject_type_allowed" CHECK ("visual_query_images"."subject_type" IN ('user', 'session')),
	CONSTRAINT "visual_query_images_content_type_allowed" CHECK ("visual_query_images"."content_type" IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "visual_query_images_size_bytes_positive" CHECK ("visual_query_images"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "listing_visual_embeddings" ADD CONSTRAINT "listing_visual_embeddings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visual_search_attempts_subject_time_idx" ON "visual_search_attempts" USING btree ("subject_type","subject_key","created_at");--> statement-breakpoint
CREATE INDEX "visual_search_attempts_created_at_idx" ON "visual_search_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_visual_embeddings_listing_id_model_uq" ON "listing_visual_embeddings" USING btree ("listing_id","model");--> statement-breakpoint
CREATE INDEX "listing_visual_embeddings_model_idx" ON "listing_visual_embeddings" USING btree ("model");--> statement-breakpoint
CREATE UNIQUE INDEX "visual_query_images_object_key_uq" ON "visual_query_images" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "visual_query_images_expires_at_idx" ON "visual_query_images" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_visual_embed_listing_listing_id_pending_uidx" ON "jobs" USING btree (("payload"->>'listingId')) WHERE "jobs"."type" = 'VISUAL_EMBED_LISTING' AND "jobs"."status" = 'PENDING';