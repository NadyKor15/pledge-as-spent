CREATE TABLE "agent_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"ip_hash" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_questions_ip" ON "agent_questions" USING btree ("ip_hash","ts");--> statement-breakpoint
CREATE INDEX "agent_questions_ts" ON "agent_questions" USING btree ("ts");