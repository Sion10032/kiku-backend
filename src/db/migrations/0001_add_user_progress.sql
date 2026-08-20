CREATE TABLE `t_user_progress` (
	`user_name` text NOT NULL,
	`work_id` text NOT NULL,
	`media_index` text NOT NULL,
	`track_title` text,
	`position` real DEFAULT 0 NOT NULL,
	`duration` real,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	PRIMARY KEY(`user_name`, `work_id`, `media_index`),
	FOREIGN KEY (`user_name`) REFERENCES `t_user`(`name`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON UPDATE no action ON DELETE cascade
);
