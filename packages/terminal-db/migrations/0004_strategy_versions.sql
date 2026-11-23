CREATE TABLE "outbox_cursors" (
	"consumer" text PRIMARY KEY NOT NULL,
	"last_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"slot" bigint,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "program_versions" (
	"program" text NOT NULL,
	"deploy_slot" bigint NOT NULL,
	"role" text NOT NULL,
	"executable_sha256" text,
	"signature" text,
	"block_time" timestamp with time zone,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"anchor" boolean,
	"program_data_slot" bigint,
	CONSTRAINT "program_versions_program_deploy_slot_pk" PRIMARY KEY("program","deploy_slot")
);
--> statement-breakpoint
CREATE TABLE "strategy_calls" (
	"signature" text NOT NULL,
	"instruction_index" smallint NOT NULL,
	"inner_index" smallint NOT NULL,
	"program" text NOT NULL,
	"discriminator" text,
	"signers" text[] NOT NULL,
	"invoked_by" text,
	"slot" bigint NOT NULL,
	"block_index" integer,
	"block_time" timestamp with time zone,
	CONSTRAINT "strategy_calls_signature_instruction_index_inner_index_pk" PRIMARY KEY("signature","instruction_index","inner_index")
);
--> statement-breakpoint
CREATE TABLE "strategy_instructions" (
	"program" text NOT NULL,
	"deploy_slot" bigint NOT NULL,
	"position" smallint NOT NULL,
	"name" text NOT NULL,
	"discriminator" text NOT NULL,
	"pipeline" boolean NOT NULL,
	CONSTRAINT "strategy_instructions_program_deploy_slot_name_pk" PRIMARY KEY("program","deploy_slot","name")
);
--> statement-breakpoint
CREATE INDEX "strategy_calls_program" ON "strategy_calls" USING btree ("program","discriminator");