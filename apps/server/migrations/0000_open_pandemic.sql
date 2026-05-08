CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ts` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_run_ts_idx` ON `events` (`run_id`,`ts`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`position_x` real DEFAULT 0 NOT NULL,
	`position_y` real DEFAULT 0 NOT NULL,
	`instruction` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_run_id` text,
	`is_favorite` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nodes_parent_idx` ON `nodes` (`parent_id`);--> statement-breakpoint
CREATE INDEX `nodes_status_idx` ON `nodes` (`status`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`coding_started_at` integer,
	`coding_finished_at` integer,
	`rendering_started_at` integer,
	`rendering_finished_at` integer,
	`critiquing_started_at` integer,
	`critiquing_finished_at` integer,
	`config_snapshot` text NOT NULL,
	`code_artifact_id` text,
	`video_artifact_id` text,
	`thumbnail_artifact_id` text,
	`critique` text,
	`cost_usd` real,
	`tokens_in` integer,
	`tokens_out` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_node_idx` ON `runs` (`node_id`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);