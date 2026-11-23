CREATE TABLE "token_images" (
	"uri" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"image_url" text,
	"sha256" text,
	"content_type" text,
	"size" integer,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mints" ADD COLUMN "symbol" text;--> statement-breakpoint
ALTER TABLE "mints" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "mints" ADD COLUMN "token_uri" text;