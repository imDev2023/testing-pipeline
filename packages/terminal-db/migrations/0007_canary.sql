CREATE TABLE "canary_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"program" text NOT NULL,
	"deploy_slot" bigint NOT NULL,
	"market" text NOT NULL,
	"check" text NOT NULL,
	"outcome" text NOT NULL,
	"harness" text NOT NULL,
	"slot" bigint NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL,
	"latest" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canary_run_markets" (
	"run_id" bigint NOT NULL,
	"market" text NOT NULL,
	"status" text NOT NULL,
	"rounds" smallint,
	"rpc_requests" integer,
	"container_ms" integer,
	"notes" jsonb,
	"error" text,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canary_run_markets_run_id_market_pk" PRIMARY KEY("run_id","market")
);
--> statement-breakpoint
CREATE TABLE "canary_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "canary_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"program" text NOT NULL,
	"deploy_slot" bigint NOT NULL,
	"trigger" text NOT NULL,
	"delay_ms" bigint DEFAULT 0 NOT NULL,
	"markets" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "canary_results" ADD CONSTRAINT "canary_results_run_id_canary_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."canary_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canary_run_markets" ADD CONSTRAINT "canary_run_markets_run_id_canary_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."canary_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canary_results_market" ON "canary_results" USING btree ("market","program","deploy_slot","check","slot" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "canary_results_latest_version" ON "canary_results" USING btree ("program","deploy_slot") WHERE latest;--> statement-breakpoint
CREATE INDEX "canary_runs_version" ON "canary_runs" USING btree ("program","deploy_slot","started_at" DESC NULLS LAST);