ALTER TABLE "orders" ADD COLUMN "public_reference" text NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "access_token_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_public_reference_unique" ON "orders" USING btree ("public_reference");--> statement-breakpoint
CREATE INDEX "orders_access_token_hash_idx" ON "orders" USING btree ("access_token_hash");