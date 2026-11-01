CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'Unmatched' NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `history` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`previous` text,
	`current` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`started` text NOT NULL,
	`finished` text,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`logs` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`group_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`image` text,
	`height` real,
	`material` text,
	`price` real,
	`currency` text,
	`stock` text,
	`status` text NOT NULL,
	`raw` text NOT NULL,
	`scraped` text NOT NULL,
	`created` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listings_url_unique` ON `listings` (`url`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`target_id` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`category` text NOT NULL,
	`status` text DEFAULT 'Paused' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`last_success` text
);
