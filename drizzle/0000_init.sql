CREATE TABLE "drives" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"base_currency" text NOT NULL,
	"disaster_date" text NOT NULL,
	"zone" jsonb NOT NULL,
	"rules" text NOT NULL,
	"status" text NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"payout_email" text,
	"created_ip_hash" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paypal_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"drive_id" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_id" text,
	"http_status" integer NOT NULL,
	"debug_id" text,
	"ids" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"drive_id" text NOT NULL,
	"sha256" text NOT NULL,
	"dhash" text,
	"semantic_key" text,
	"image" "bytea" NOT NULL,
	"image_redacted" "bytea",
	"media_type" text NOT NULL,
	"parsed" jsonb,
	"classified" jsonb,
	"checks" jsonb,
	"status" text NOT NULL,
	"channel" text NOT NULL,
	"reader" text NOT NULL,
	"ip_hash" text,
	"decision" jsonb,
	"uploaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"what" text NOT NULL,
	"usd" numeric(14, 6) NOT NULL,
	"ref" text
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource" jsonb,
	"verified" boolean NOT NULL,
	"raw" jsonb NOT NULL,
	"drive_id" text,
	"note" text,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "drives_status" ON "drives" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drives_ip" ON "drives" USING btree ("created_ip_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_drive_seq" ON "events" USING btree ("drive_id","seq");--> statement-breakpoint
CREATE INDEX "events_type" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "paypal_calls_drive" ON "paypal_calls" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX "paypal_calls_request" ON "paypal_calls" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "receipts_drive" ON "receipts" USING btree ("drive_id");--> statement-breakpoint
CREATE INDEX "receipts_sha" ON "receipts" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "receipts_ip" ON "receipts" USING btree ("ip_hash","uploaded_at");