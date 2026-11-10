CREATE TABLE "line_translations" (
	"receipt_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"lang" text NOT NULL,
	"text" text NOT NULL,
	"model" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "line_translations_receipt_id_line_no_lang_pk" PRIMARY KEY("receipt_id","line_no","lang")
);
