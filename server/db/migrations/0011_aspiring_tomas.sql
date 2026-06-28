ALTER TABLE `devices` ADD `command_secret` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `command_secret_active` integer DEFAULT false NOT NULL;