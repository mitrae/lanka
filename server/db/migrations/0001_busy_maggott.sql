CREATE TABLE `device_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`sha256` text,
	`message` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_errors_device_idx` ON `device_errors` (`device_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `media` ADD `mime_type` text DEFAULT 'application/octet-stream' NOT NULL;--> statement-breakpoint
ALTER TABLE `media` ADD `thumbnail_bytes` integer;