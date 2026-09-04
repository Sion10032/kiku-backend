CREATE TABLE `t_series` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `t_work` ADD `series_id` text REFERENCES t_series(id);