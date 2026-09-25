CREATE TABLE "id_rekeys" (
	"resource_table" text NOT NULL,
	"old_id" uuid NOT NULL,
	"new_id" uuid NOT NULL,
	CONSTRAINT "id_rekeys_resource_table_old_id_pk" PRIMARY KEY("resource_table","old_id"),
	CONSTRAINT "id_rekeys_table_new_uq" UNIQUE("resource_table","new_id")
);
