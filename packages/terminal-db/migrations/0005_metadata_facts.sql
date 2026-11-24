CREATE TABLE "metadata_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "metadata_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"program" text NOT NULL,
	"uri" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"errors" text[] NOT NULL,
	"warnings" text[] NOT NULL,
	"url" text,
	"sha256" text,
	"document" jsonb,
	"normalised" jsonb,
	"removed" jsonb,
	"fetched_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_facts" (
	"program" text PRIMARY KEY NOT NULL,
	"upgrade_authority" text,
	"flags" text[] NOT NULL,
	"read_slot" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mints" ADD COLUMN "flags" text[];--> statement-breakpoint
ALTER TABLE "mints" ADD COLUMN "read_epoch" bigint;--> statement-breakpoint
CREATE INDEX "metadata_snapshots_program" ON "metadata_snapshots" USING btree ("program","id");