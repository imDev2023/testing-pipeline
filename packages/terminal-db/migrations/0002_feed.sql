CREATE TABLE "indexed_transactions" (
	"signature" text PRIMARY KEY NOT NULL,
	"slot" bigint NOT NULL,
	"block_index" integer,
	"block_time" timestamp with time zone,
	"decoder_version" integer NOT NULL,
	"unknown_events" integer DEFAULT 0 NOT NULL,
	"raw" jsonb,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_mints" (
	"market" text NOT NULL,
	"position" smallint NOT NULL,
	"mint" text NOT NULL,
	"vault" text,
	"vault_amount" numeric(20, 0),
	CONSTRAINT "market_mints_market_position_pk" PRIMARY KEY("market","position")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"address" text PRIMARY KEY NOT NULL,
	"strategy_program" text NOT NULL,
	"market_state" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_slot" bigint,
	"created_signature" text,
	"supports_exact_out" boolean,
	"fee_mint" text,
	"state_data" text,
	"read_slot" bigint
);
--> statement-breakpoint
CREATE TABLE "mints" (
	"address" text PRIMARY KEY NOT NULL,
	"readable" boolean NOT NULL,
	"token_program" text,
	"decimals" smallint,
	"supply" numeric(20, 0),
	"mint_authority" text,
	"freeze_authority" text,
	"data" text,
	"metadata_data" text,
	"read_slot" bigint
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"program" text PRIMARY KEY NOT NULL,
	"metadata_uri" text NOT NULL,
	"fee_paid" numeric(20, 0),
	"registered_at" timestamp with time zone NOT NULL,
	"registered_slot" bigint,
	"registered_signature" text,
	"metadata_slot" bigint
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"signature" text NOT NULL,
	"event_index" smallint NOT NULL,
	"slot" bigint NOT NULL,
	"block_index" integer,
	"block_time" timestamp with time zone,
	"market" text NOT NULL,
	"strategy" text NOT NULL,
	"trader" text NOT NULL,
	"input_mint" text NOT NULL,
	"output_mint" text NOT NULL,
	"mode" smallint NOT NULL,
	"net_sent" numeric(20, 0) NOT NULL,
	"received" numeric(20, 0) NOT NULL,
	"pipeline_fee" numeric(20, 0) NOT NULL,
	"fee_mint" text NOT NULL,
	"integrator" text,
	"integrator_fee" numeric(20, 0) NOT NULL,
	"unix_timestamp" bigint NOT NULL,
	CONSTRAINT "trades_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "block_index" integer;--> statement-breakpoint
CREATE INDEX "indexed_transactions_unknown" ON "indexed_transactions" USING btree ("decoder_version") WHERE unknown_events > 0;--> statement-breakpoint
CREATE INDEX "market_mints_mint" ON "market_mints" USING btree ("mint");--> statement-breakpoint
CREATE INDEX "markets_newest" ON "markets" USING btree ("created_at","address");--> statement-breakpoint
CREATE INDEX "markets_strategy" ON "markets" USING btree ("strategy_program");--> statement-breakpoint
CREATE INDEX "trades_market_order" ON "trades" USING btree ("market","slot","block_index","event_index");--> statement-breakpoint
CREATE INDEX "trades_trader_order" ON "trades" USING btree ("trader","slot","block_index","event_index");--> statement-breakpoint
CREATE INDEX "trades_time" ON "trades" USING btree ("unix_timestamp");