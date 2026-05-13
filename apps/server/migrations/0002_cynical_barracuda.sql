ALTER TABLE `nodes` ADD `branch_anchor_id` text;--> statement-breakpoint
CREATE INDEX `nodes_branch_anchor_idx` ON `nodes` (`branch_anchor_id`);