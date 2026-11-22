CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`size_kind` text NOT NULL,
	`size_label` text NOT NULL,
	`size_unit` text,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`name` text NOT NULL,
	`image` text,
	`status` text DEFAULT 'Active' NOT NULL,
	`merged_into_event_id` text,
	`created` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `groups_cat_status` ON `groups` (`category_id`,`status`);--> statement-breakpoint
CREATE INDEX `groups_cat_status_name` ON `groups` (`category_id`,`status`,`name`);--> statement-breakpoint
CREATE TABLE `history` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`kind` text NOT NULL,
	`previous` text,
	`current` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_at` ON `history` (`at`);--> statement-breakpoint
CREATE INDEX `history_listing` ON `history` (`listing_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`started` text NOT NULL,
	`finished` text,
	`selected` text DEFAULT '[]' NOT NULL,
	`log` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`group_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`image` text,
	`height` text,
	`material` text,
	`size_value` text,
	`price` real,
	`previous_price` real,
	`price_changed_at` text,
	`currency` text,
	`stock` text DEFAULT 'Unknown' NOT NULL,
	`status` text DEFAULT 'NEW' NOT NULL,
	`raw` text,
	`scraped` text NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listings_url_uq` ON `listings` (`url`);--> statement-breakpoint
CREATE INDEX `listings_group` ON `listings` (`group_id`);--> statement-breakpoint
CREATE INDEX `listings_supplier` ON `listings` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `listings_status` ON `listings` (`status`);--> statement-breakpoint
CREATE TABLE `merge_event_listings` (
	`merge_event_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`from_group_id` text NOT NULL,
	PRIMARY KEY(`merge_event_id`, `listing_id`),
	FOREIGN KEY (`merge_event_id`) REFERENCES `merge_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `merge_event_sources` (
	`merge_event_id` text NOT NULL,
	`source_group_id` text NOT NULL,
	PRIMARY KEY(`merge_event_id`, `source_group_id`),
	FOREIGN KEY (`merge_event_id`) REFERENCES `merge_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `merge_events` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`result_group_id` text NOT NULL,
	`name` text NOT NULL,
	`image` text,
	`note` text,
	`created` text NOT NULL,
	`undone_at` text,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_events_result_group_id_unique` ON `merge_events` (`result_group_id`);--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`price` real,
	`currency` text,
	`stock` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ph_listing_time` ON `price_history` (`listing_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `ph_time` ON `price_history` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'Paused' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`last_success` text,
	`deleted_at` text,
	`created` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
