CREATE TABLE "indexer_cursors" (
	"account" text PRIMARY KEY NOT NULL,
	"signature" text,
	"slot" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
