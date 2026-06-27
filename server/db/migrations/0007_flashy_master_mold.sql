ALTER TABLE `media` ADD `source_sha256` text;--> statement-breakpoint
CREATE INDEX `media_source_sha_idx` ON `media` (`source_sha256`);