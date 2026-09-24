ALTER TABLE "users" ALTER COLUMN "student_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "campus";