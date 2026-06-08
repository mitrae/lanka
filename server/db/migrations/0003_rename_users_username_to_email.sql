ALTER TABLE `users` RENAME COLUMN `username` TO `email`;--> statement-breakpoint
DROP INDEX `users_username_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);
