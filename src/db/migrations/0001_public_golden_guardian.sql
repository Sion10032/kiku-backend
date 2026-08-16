PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_t_review` (
	`user_name` text NOT NULL,
	`work_id` text NOT NULL,
	`rating` integer,
	`review_text` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP',
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP',
	`progress` text,
	PRIMARY KEY(`user_name`, `work_id`),
	FOREIGN KEY (`user_name`) REFERENCES `t_user`(`name`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_t_review`("user_name", "work_id", "rating", "review_text", "created_at", "updated_at", "progress") SELECT "user_name", "work_id", "rating", "review_text", "created_at", "updated_at", "progress" FROM `t_review`;--> statement-breakpoint
DROP TABLE `t_review`;--> statement-breakpoint
ALTER TABLE `__new_t_review` RENAME TO `t_review`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_r_tag_work` (
	`tag_id` integer NOT NULL,
	`work_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `work_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `t_tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_r_tag_work`("tag_id", "work_id") SELECT "tag_id", "work_id" FROM `r_tag_work`;--> statement-breakpoint
DROP TABLE `r_tag_work`;--> statement-breakpoint
ALTER TABLE `__new_r_tag_work` RENAME TO `r_tag_work`;--> statement-breakpoint
CREATE TABLE `__new_r_va_work` (
	`va_id` text NOT NULL,
	`work_id` text NOT NULL,
	PRIMARY KEY(`va_id`, `work_id`),
	FOREIGN KEY (`va_id`) REFERENCES `t_va`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_r_va_work`("va_id", "work_id") SELECT "va_id", "work_id" FROM `r_va_work`;--> statement-breakpoint
DROP TABLE `r_va_work`;--> statement-breakpoint
ALTER TABLE `__new_r_va_work` RENAME TO `r_va_work`;--> statement-breakpoint
CREATE TABLE `__new_t_work` (
	`id` text PRIMARY KEY NOT NULL,
	`root_folder` text NOT NULL,
	`dir` text NOT NULL,
	`title` text NOT NULL,
	`circle_id` integer NOT NULL,
	`nsfw` integer,
	`release` text,
	`dl_count` integer,
	`price` integer,
	`review_count` integer,
	`rate_count` integer,
	`rate_average_2dp` real,
	`rate_count_detail` text,
	`rank` text,
	FOREIGN KEY (`circle_id`) REFERENCES `t_circle`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_t_work`("id", "root_folder", "dir", "title", "circle_id", "nsfw", "release", "dl_count", "price", "review_count", "rate_count", "rate_average_2dp", "rate_count_detail", "rank") SELECT "id", "root_folder", "dir", "title", "circle_id", "nsfw", "release", "dl_count", "price", "review_count", "rate_count", "rate_average_2dp", "rate_count_detail", "rank" FROM `t_work`;--> statement-breakpoint
DROP TABLE `t_work`;--> statement-breakpoint
ALTER TABLE `__new_t_work` RENAME TO `t_work`;