-- 本行是 AGENTS.md §8「第二处例外」允许的唯一手加内容：drizzle-kit 0.31 不能生成
-- CREATE EXTENSION，而 `generate --custom` 只产 .sql + journal 条目、不产 snapshot，
-- 会踩红 packages/db/src/migrations-journal.test.ts 的「snapshot 数量 === journal 条目数」断言。
-- 必须排在 CREATE TABLE 之前：vector 类型要先存在。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"listing_id" uuid,
	"wish_id" uuid,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeddings_exactly_one_entity" CHECK (("embeddings"."listing_id" is null) <> ("embeddings"."wish_id" is null)),
	CONSTRAINT "embeddings_dimensions_matches_column" CHECK ("embeddings"."dimensions" = 1536)
);
--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_wish_id_wishes_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."wishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_listing_id_model_uq" ON "embeddings" USING btree ("listing_id","model") WHERE "embeddings"."listing_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_wish_id_model_uq" ON "embeddings" USING btree ("wish_id","model") WHERE "embeddings"."wish_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_embed_listing_listing_id_uidx" ON "jobs" USING btree (("payload"->>'listingId')) WHERE "jobs"."type" = 'EMBED_LISTING' AND "jobs"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_embed_wish_wish_id_uidx" ON "jobs" USING btree (("payload"->>'wishId')) WHERE "jobs"."type" = 'EMBED_WISH' AND "jobs"."status" = 'PENDING';