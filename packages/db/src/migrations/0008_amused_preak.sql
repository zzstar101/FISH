CREATE TYPE "public"."message_media_kind" AS ENUM('IMAGE', 'VOICE');--> statement-breakpoint
ALTER TYPE "public"."message_type" ADD VALUE 'MEDIA';--> statement-breakpoint
CREATE TABLE "message_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" "message_media_kind" NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_media_size_positive" CHECK ("message_media"."size_bytes" > 0),
	CONSTRAINT "message_media_image_dimensions" CHECK (("message_media"."kind" <> 'IMAGE') OR ("message_media"."width" IS NOT NULL AND "message_media"."height" IS NOT NULL)),
	CONSTRAINT "message_media_voice_duration" CHECK (("message_media"."kind" <> 'VOICE') OR ("message_media"."duration_ms" IS NOT NULL AND "message_media"."duration_ms" > 0))
);
--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_media_message_id_uq" ON "message_media" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_media_object_key_uq" ON "message_media" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "message_media_conversation_id_created_at_idx" ON "message_media" USING btree ("conversation_id","created_at");