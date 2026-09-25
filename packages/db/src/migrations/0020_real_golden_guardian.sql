CREATE TABLE "listing_numbers" (
	"listing_no" bigint PRIMARY KEY NOT NULL,
	"listing_id" uuid NOT NULL,
	CONSTRAINT "listing_numbers_listing_id_unique" UNIQUE("listing_id"),
	CONSTRAINT "listing_numbers_no_id_uq" UNIQUE("listing_no","listing_id"),
	CONSTRAINT "listing_numbers_twelve_digits" CHECK ("listing_numbers"."listing_no" BETWEEN 100000000000 AND 999999999999)
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "listing_no" bigint;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_listing_no_uq" UNIQUE("listing_no");