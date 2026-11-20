CREATE TYPE "public"."listing_type" AS ENUM('SALE', 'RENTAL');--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "listing_type" "listing_type" DEFAULT 'SALE' NOT NULL;