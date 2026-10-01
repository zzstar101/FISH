CREATE TABLE "user_interest_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"strategy_version" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"action_count" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_interest_profiles_action_count_positive" CHECK ("user_interest_profiles"."action_count" >= 1),
	CONSTRAINT "user_interest_profiles_dimensions_matches_column" CHECK ("user_interest_profiles"."dimensions" = 1536)
);
--> statement-breakpoint
ALTER TABLE "user_interest_profiles" ADD CONSTRAINT "user_interest_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_interest_profiles_user_id_model_uq" ON "user_interest_profiles" USING btree ("user_id","model");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_refresh_user_interest_user_id_pending_uidx" ON "jobs" USING btree (("payload"->>'userId')) WHERE "jobs"."type" = 'REFRESH_USER_INTEREST' AND "jobs"."status" = 'PENDING';