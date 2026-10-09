CREATE TABLE "listing_image_deletions" (
	"object_key" text PRIMARY KEY NOT NULL,
	"removed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_image_deletions_public_prefix" CHECK ("listing_image_deletions"."object_key" LIKE 'listings/%')
);
--> statement-breakpoint
CREATE INDEX "listing_image_deletions_removed_at_idx" ON "listing_image_deletions" USING btree ("removed_at");