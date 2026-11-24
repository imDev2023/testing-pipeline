CREATE TABLE "strategy_events" (
	"signature" text NOT NULL,
	"position" smallint NOT NULL,
	"program" text NOT NULL,
	"discriminator" text,
	"subject" text,
	"data" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_index" integer,
	"block_time" timestamp with time zone,
	CONSTRAINT "strategy_events_signature_position_pk" PRIMARY KEY("signature","position")
);
--> statement-breakpoint
CREATE INDEX "strategy_events_subject" ON "strategy_events" USING btree ("program","subject","slot" DESC NULLS LAST);