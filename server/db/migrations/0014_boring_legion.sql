ALTER TABLE `devices` ADD `visibility` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `visibility_since` integer;--> statement-breakpoint
ALTER TABLE `devices` ADD `foreground_package` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `snap_backs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `focus_losses` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devices` ADD `hidden_ms` integer DEFAULT 0 NOT NULL;