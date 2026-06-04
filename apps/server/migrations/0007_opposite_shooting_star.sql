CREATE TABLE `node_references` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_run_id` text,
	`file_path` text,
	`mime` text,
	`label` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `node_references_node_idx` ON `node_references` (`node_id`);