CREATE TABLE "keeper_run_jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "keeper_run_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"market" text,
	"product" text,
	"job" text NOT NULL,
	"slot" integer,
	"outcome" text NOT NULL,
	"signature" text,
	"cost" bigint,
	"estimate" bigint,
	"cap" text,
	"error" text,
	"attempt" integer
);
--> statement-breakpoint
CREATE TABLE "keeper_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "keeper_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wallet" text NOT NULL,
	"pass" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"balance" bigint,
	"day" date NOT NULL,
	"spent_total" bigint,
	"spent_by_market" jsonb,
	"caps" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"warnings" text[] NOT NULL,
	"markets" integer NOT NULL,
	"sent" integer NOT NULL,
	"held" integer NOT NULL,
	"parked" integer NOT NULL,
	"skipped" integer NOT NULL,
	"failed" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keeper_run_jobs" ADD CONSTRAINT "keeper_run_jobs_run_id_keeper_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."keeper_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "keeper_run_jobs_run" ON "keeper_run_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "keeper_run_jobs_unit" ON "keeper_run_jobs" USING btree ("market","job","slot","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "keeper_runs_wallet_at" ON "keeper_runs" USING btree ("wallet","at" DESC NULLS LAST);