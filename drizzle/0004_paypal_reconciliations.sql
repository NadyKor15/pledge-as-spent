CREATE TABLE "paypal_reconciliations" (
	"id" serial PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"total" integer NOT NULL,
	"answered" integer NOT NULL,
	"agrees" integer NOT NULL,
	"differences" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "paypal_reconciliations_drive" ON "paypal_reconciliations" USING btree ("drive_id","asked_at");