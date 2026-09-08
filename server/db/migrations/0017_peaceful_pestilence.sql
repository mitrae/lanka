CREATE TABLE `interrupts` (
	`id` integer PRIMARY KEY NOT NULL,
	`media_id` integer NOT NULL,
	`at_minutes` integer NOT NULL,
	`timezone` text DEFAULT 'Europe/Kyiv' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`label` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `last_interrupt_at` integer;