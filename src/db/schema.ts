import { boolean, customType, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// The events table is the drive's book: append only, state = replay(events).
// Every other table is either a mirror for queries (drives) or data the book
// does not hold (receipt images and readings, PayPal audit, webhook inbox, spend).

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  // PGlite returns Uint8Array, node/neon drivers a Buffer (a Uint8Array subclass).
  fromDriver: (v) => (v instanceof Uint8Array ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : (v as Uint8Array)),
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    driveId: text("drive_id").notNull(),
    seq: integer("seq").notNull(),
    at: ts("at").notNull(),
    type: text("type").notNull(),
    /** app | paypal_response | webhook | paypal_lookup */
    source: text("source").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [uniqueIndex("events_drive_seq").on(t.driveId, t.seq), index("events_type").on(t.type)],
);

export const drives = pgTable(
  "drives",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    baseCurrency: text("base_currency").notNull(),
    disasterDate: text("disaster_date").notNull(),
    zone: jsonb("zone").$type<string[]>().notNull(),
    rules: text("rules").notNull(),
    status: text("status").notNull(),
    demo: boolean("demo").notNull().default(false),
    /** Where volunteer reimbursements go; null: payouts are not sent. */
    payoutEmail: text("payout_email"),
    createdIpHash: text("created_ip_hash"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("drives_status").on(t.status), index("drives_ip").on(t.createdIpHash, t.createdAt)],
);

export const receipts = pgTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    driveId: text("drive_id").notNull(),
    sha256: text("sha256").notNull(),
    dhash: text("dhash"),
    semanticKey: text("semantic_key"),
    image: bytea("image").notNull(),
    /** The only copy that is ever published; null when personal data could not be blurred. */
    imageRedacted: bytea("image_redacted"),
    mediaType: text("media_type").notNull(),
    parsed: jsonb("parsed"),
    classified: jsonb("classified"),
    checks: jsonb("checks"),
    /** review | funded | rejected */
    status: text("status").notNull(),
    channel: text("channel").notNull(),
    /** recorded | nova | copy */
    reader: text("reader").notNull(),
    ipHash: text("ip_hash"),
    decision: jsonb("decision"),
    uploadedAt: ts("uploaded_at").notNull(),
  },
  (t) => [index("receipts_drive").on(t.driveId), index("receipts_sha").on(t.sha256), index("receipts_ip").on(t.ipHash, t.uploadedAt)],
);

export const paypalCalls = pgTable(
  "paypal_calls",
  {
    id: serial("id").primaryKey(),
    ts: ts("ts").notNull(),
    driveId: text("drive_id"),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestId: text("request_id"),
    httpStatus: integer("http_status").notNull(),
    debugId: text("debug_id"),
    ids: jsonb("ids").$type<Record<string, string>>().notNull(),
  },
  (t) => [index("paypal_calls_drive").on(t.driveId), index("paypal_calls_request").on(t.requestId)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  resourceType: text("resource_type"),
  resource: jsonb("resource"),
  verified: boolean("verified").notNull(),
  raw: jsonb("raw").notNull(),
  driveId: text("drive_id"),
  note: text("note"),
  receivedAt: ts("received_at").notNull(),
  processedAt: ts("processed_at"),
});

export const spendLedger = pgTable("spend_ledger", {
  id: text("id").primaryKey(),
  ts: ts("ts").notNull(),
  kind: text("kind").notNull(),
  what: text("what").notNull(),
  usd: numeric("usd", { precision: 14, scale: 6 }).notNull(),
  ref: text("ref"),
});

/** One question to the live agent: who asked (hashed address) and what it has cost so far. */
export const agentQuestions = pgTable(
  "agent_questions",
  {
    id: text("id").primaryKey(),
    ipHash: text("ip_hash").notNull(),
    ts: ts("ts").notNull(),
    /** Model calls made for this question, delegates included. */
    calls: integer("calls").notNull().default(0),
    /** Estimated input tokens sent for this question. */
    tokens: integer("tokens").notNull().default(0),
  },
  (t) => [index("agent_questions_ip").on(t.ipHash, t.ts), index("agent_questions_ts").on(t.ts)],
);

export const schema = { events, drives, receipts, paypalCalls, webhookEvents, spendLedger, agentQuestions };
