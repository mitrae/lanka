CREATE TABLE `media_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`kind` text NOT NULL,
	`quality` text DEFAULT 'standard' NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`media_id` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `media_uploads_status_idx` ON `media_uploads` (`status`);--> statement-breakpoint
CREATE INDEX `media_uploads_created_idx` ON `media_uploads` (`created_at`);