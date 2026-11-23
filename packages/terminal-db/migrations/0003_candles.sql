CREATE TABLE "candles" (
	"market" text NOT NULL,
	"mint_a" text NOT NULL,
	"mint_b" text NOT NULL,
	"seconds" integer NOT NULL,
	"start" bigint NOT NULL,
	"open_a" numeric(20, 0) NOT NULL,
	"open_b" numeric(20, 0) NOT NULL,
	"high_a" numeric(20, 0) NOT NULL,
	"high_b" numeric(20, 0) NOT NULL,
	"low_a" numeric(20, 0) NOT NULL,
	"low_b" numeric(20, 0) NOT NULL,
	"close_a" numeric(20, 0) NOT NULL,
	"close_b" numeric(20, 0) NOT NULL,
	"open_key" text NOT NULL,
	"close_key" text NOT NULL,
	"volume_a" numeric(40, 0) NOT NULL,
	"volume_b" numeric(40, 0) NOT NULL,
	"trades" integer NOT NULL,
	CONSTRAINT "candles_market_mint_a_mint_b_seconds_start_pk" PRIMARY KEY("market","mint_a","mint_b","seconds","start")
);
--> statement-breakpoint
CREATE INDEX "candles_retention" ON "candles" USING btree ("seconds","start");