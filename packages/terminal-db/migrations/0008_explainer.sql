CREATE TABLE "explainer_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"program" text NOT NULL,
	"deploy_slot" bigint NOT NULL,
	"author_text_sha256" text NOT NULL,
	"canary_outcomes_sha256" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"representative_market" text,
	"author_text_addresses_ai" boolean NOT NULL,
	"estimated_input_tokens" integer NOT NULL,
	"estimated_cost_usd" numeric(12, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"explanation" jsonb,
	"validation" jsonb,
	"attempts" smallint,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"failure" text,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "explainer_reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "explainer_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "explainer_reports" ADD CONSTRAINT "explainer_reports_key_explainer_keys_key_fk" FOREIGN KEY ("key") REFERENCES "public"."explainer_keys"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "explainer_keys_program" ON "explainer_keys" USING btree ("program","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "explainer_keys_pending" ON "explainer_keys" USING btree ("created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "explainer_reports_newest" ON "explainer_reports" USING btree ("created_at" DESC NULLS LAST);