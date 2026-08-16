CREATE TABLE `t_circle` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `t_review` (
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
CREATE TABLE `r_tag_work` (
	`tag_id` integer NOT NULL,
	`work_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `work_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `t_tag`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `t_tag` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `t_user` (
	`name` text PRIMARY KEY NOT NULL,
	`password` text NOT NULL,
	`group` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `r_va_work` (
	`va_id` text NOT NULL,
	`work_id` text NOT NULL,
	PRIMARY KEY(`va_id`, `work_id`),
	FOREIGN KEY (`va_id`) REFERENCES `t_va`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `t_va` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `t_work` (
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
	`language` text,
	`source_id` text,
	FOREIGN KEY (`circle_id`) REFERENCES `t_circle`(`id`) ON UPDATE no action ON DELETE no action
);
