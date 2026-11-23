DROP INDEX `listings_url_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `listings_supplier_url_uq` ON `listings` (`supplier_id`,`url`);--> statement-breakpoint
CREATE INDEX `listings_url` ON `listings` (`url`);