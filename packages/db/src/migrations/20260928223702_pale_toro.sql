ALTER TABLE "matches" ADD COLUMN "semantic_score" smallint;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "ranking_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_semantic_score_range" CHECK ("matches"."semantic_score" IS NULL OR ("matches"."semantic_score" >= 0 AND "matches"."semantic_score" <= 100));--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_ranking_version_known" CHECK ("matches"."ranking_version" IN (1, 2));