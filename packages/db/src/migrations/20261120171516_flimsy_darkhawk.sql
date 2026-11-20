ALTER TABLE "users" DROP CONSTRAINT "users_student_no_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "uid" text DEFAULT (floor(random() * 9000000000) + 1000000000)::text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_uid_uq" ON "users" USING btree ("uid");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "student_no";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_uid_format" CHECK ("users"."uid" ~ '^[1-9][0-9]{9}$');