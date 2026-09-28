-- #322 M1：embeddings.embedding 用 pgvector 的 `vector` 类型，扩展必须先于 CREATE TABLE 存在。
-- 本行是本仓库「不手改生成迁移」的唯一一处**追加式**例外（只加不提：生成器产出的语句一个字节不动），
-- 理由与边界见根 AGENTS.md 第 8 节与 packages/db/AGENTS.md 的「pgvector 扩展」一条：
-- drizzle-kit 0.31 / drizzle-orm 0.45 都没有 `CREATE EXTENSION` 的表达能力（无 `pgExtension`），
-- 而 `drizzle-kit generate --custom` 只产 `.sql` 与 journal 条目、**不产 snapshot**，
-- 会直接踩红 `src/migrations-journal.test.ts` 的「snapshot 数量 === journal 条目数」断言。
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"listing_id" uuid,
	"wish_id" uuid,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
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