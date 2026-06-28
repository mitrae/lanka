DROP INDEX `media_source_sha_idx`;--> statement-breakpoint
ALTER TABLE `media` ADD `quality` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
CREATE INDEX `media_source_sha_idx` ON `media` (`source_sha256`,`quality`);