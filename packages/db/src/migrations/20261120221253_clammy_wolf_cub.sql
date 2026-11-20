CREATE TABLE "rental_terms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"listing_id" uuid NOT NULL,
	"deposit_cents" integer NOT NULL,
	"rules" text,
	"min_days" integer NOT NULL,
	"max_days" integer NOT NULL,
	"terms_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rental_terms_listing_id_uq" UNIQUE("listing_id"),
	CONSTRAINT "rental_terms_min_days_range" CHECK ("rental_terms"."min_days" >= 1 AND "rental_terms"."min_days" <= 90),
	CONSTRAINT "rental_terms_max_days_range" CHECK ("rental_terms"."max_days" >= "rental_terms"."min_days" AND "rental_terms"."max_days" <= 90),
	CONSTRAINT "rental_terms_deposit_non_negative" CHECK ("rental_terms"."deposit_cents" >= 0),
	CONSTRAINT "rental_terms_version_positive" CHECK ("rental_terms"."terms_version" >= 1),
	CONSTRAINT "rental_terms_rules_length" CHECK ("rental_terms"."rules" IS NULL OR char_length("rental_terms"."rules") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "rental_terms" ADD CONSTRAINT "rental_terms_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rental_terms_max_days_idx" ON "rental_terms" USING btree ("max_days");