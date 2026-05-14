CREATE TABLE `canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`slug` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvases_slug_unique` ON `canvases` (`slug`);--> statement-breakpoint
ALTER TABLE `nodes` ADD `canvas_id` text NOT NULL REFERENCES canvases(id);--> statement-breakpoint
CREATE INDEX `nodes_canvas_idx` ON `nodes` (`canvas_id`);