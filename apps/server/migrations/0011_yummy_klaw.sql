ALTER TABLE `runs` ADD `output_artifact_id` text;--> statement-breakpoint
UPDATE `runs` SET `output_artifact_id` = `video_artifact_id` WHERE `video_artifact_id` IS NOT NULL;
