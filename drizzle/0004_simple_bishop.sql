CREATE TYPE "public"."object_cleanup_reason" AS ENUM('cover_replaced', 'cover_removed', 'event_deleted');--> statement-breakpoint
CREATE TYPE "public"."object_cleanup_status" AS ENUM('pending', 'abandoned');--> statement-breakpoint
CREATE TABLE "object_cleanup_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_key" text NOT NULL,
	"reason" "object_cleanup_reason" NOT NULL,
	"status" "object_cleanup_status" DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "object_cleanup_queue_object_key_unique" ON "object_cleanup_queue" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "object_cleanup_queue_status_scheduled_idx" ON "object_cleanup_queue" USING btree ("status","scheduled_at");