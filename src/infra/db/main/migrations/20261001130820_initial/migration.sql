CREATE TABLE `circles` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `favourites` (
	`user_name` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	CONSTRAINT `favourites_pk` PRIMARY KEY(`user_name`, `target_type`, `target_id`),
	CONSTRAINT `fk_favourites_user_name_users_name_fk` FOREIGN KEY (`user_name`) REFERENCES `users`(`name`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `read_states` (
	`user_name` text NOT NULL,
	`work_id` text NOT NULL,
	`read_at` text NOT NULL,
	CONSTRAINT `read_states_pk` PRIMARY KEY(`user_name`, `work_id`),
	CONSTRAINT `fk_read_states_user_name_users_name_fk` FOREIGN KEY (`user_name`) REFERENCES `users`(`name`) ON DELETE CASCADE,
	CONSTRAINT `fk_read_states_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`user_name` text NOT NULL,
	`work_id` text NOT NULL,
	`rating` integer,
	`review_text` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP',
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP',
	CONSTRAINT `reviews_pk` PRIMARY KEY(`user_name`, `work_id`),
	CONSTRAINT `fk_reviews_user_name_users_name_fk` FOREIGN KEY (`user_name`) REFERENCES `users`(`name`) ON DELETE CASCADE,
	CONSTRAINT `fk_reviews_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `root_folders` (
	`name` text PRIMARY KEY,
	`path` text
);
--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings_backups` (
	`user_name` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `settings_backups_pk` PRIMARY KEY(`user_name`, `name`),
	CONSTRAINT `fk_settings_backups_user_name_users_name_fk` FOREIGN KEY (`user_name`) REFERENCES `users`(`name`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tag_work` (
	`tag_id` integer NOT NULL,
	`work_id` text NOT NULL,
	CONSTRAINT `tag_work_pk` PRIMARY KEY(`tag_id`, `work_id`),
	CONSTRAINT `fk_tag_work_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tag_work_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tag_work_override` (
	`work_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	`action` text NOT NULL,
	CONSTRAINT `tag_work_override_pk` PRIMARY KEY(`work_id`, `tag_id`),
	CONSTRAINT `fk_tag_work_override_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tag_work_override_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracks` (
	`work_id` text NOT NULL,
	`media_index` text NOT NULL,
	`title` text NOT NULL,
	`duration_sec` real,
	`size_bytes` integer NOT NULL,
	`loudness_lufs` real,
	`loudness_true_peak_db` real,
	`analyzed_at` text,
	`analyze_error` text,
	`loudness_curve` text,
	CONSTRAINT `tracks_pk` PRIMARY KEY(`work_id`, `media_index`),
	CONSTRAINT `fk_tracks_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user_progress` (
	`user_name` text NOT NULL,
	`work_id` text NOT NULL,
	`media_index` text NOT NULL,
	`track_title` text,
	`position` real DEFAULT 0 NOT NULL,
	`duration` real,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	CONSTRAINT `user_progress_pk` PRIMARY KEY(`user_name`, `work_id`, `media_index`),
	CONSTRAINT `fk_user_progress_user_name_users_name_fk` FOREIGN KEY (`user_name`) REFERENCES `users`(`name`) ON DELETE CASCADE,
	CONSTRAINT `fk_user_progress_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`name` text PRIMARY KEY,
	`password` text NOT NULL,
	`group` text NOT NULL,
	`token_version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `va_work` (
	`va_id` text NOT NULL,
	`work_id` text NOT NULL,
	CONSTRAINT `va_work_pk` PRIMARY KEY(`va_id`, `work_id`),
	CONSTRAINT `fk_va_work_va_id_vas_id_fk` FOREIGN KEY (`va_id`) REFERENCES `vas`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_va_work_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `va_work_override` (
	`work_id` text NOT NULL,
	`va_id` text NOT NULL,
	`action` text NOT NULL,
	CONSTRAINT `va_work_override_pk` PRIMARY KEY(`work_id`, `va_id`),
	CONSTRAINT `fk_va_work_override_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_va_work_override_va_id_vas_id_fk` FOREIGN KEY (`va_id`) REFERENCES `vas`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `vas` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_meta_overrides` (
	`work_id` text PRIMARY KEY,
	`title` text,
	`circle_id` text,
	`series_id` text,
	`age_rating` text,
	`tags_cleared` integer DEFAULT 0 NOT NULL,
	`vas_cleared` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	CONSTRAINT `fk_work_meta_overrides_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_meta_overrides_circle_id_circles_id_fk` FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE CASCADE,
	CONSTRAINT `fk_work_meta_overrides_series_id_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `series`(`id`)
);
--> statement-breakpoint
CREATE TABLE `works` (
	`id` text PRIMARY KEY,
	`root_folder` text NOT NULL,
	`dir` text NOT NULL,
	`title` text NOT NULL,
	`circle_id` text NOT NULL,
	`age_rating` text DEFAULT 'r18' NOT NULL,
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
	`series_id` text,
	`deleted_at` text,
	`loudness_lufs` real,
	`loudness_true_peak_db` real,
	CONSTRAINT `fk_works_root_folder_root_folders_name_fk` FOREIGN KEY (`root_folder`) REFERENCES `root_folders`(`name`) ON UPDATE CASCADE ON DELETE RESTRICT,
	CONSTRAINT `fk_works_circle_id_circles_id_fk` FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE CASCADE,
	CONSTRAINT `fk_works_series_id_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `series`(`id`)
);
--> statement-breakpoint
CREATE INDEX `tag_work_work_id_idx` ON `tag_work` (`work_id`);--> statement-breakpoint
CREATE INDEX `tag_work_override_work_id_idx` ON `tag_work_override` (`work_id`);--> statement-breakpoint
CREATE INDEX `tag_work_override_tag_id_idx` ON `tag_work_override` (`tag_id`);--> statement-breakpoint
CREATE INDEX `va_work_work_id_idx` ON `va_work` (`work_id`);--> statement-breakpoint
CREATE INDEX `va_work_override_work_id_idx` ON `va_work_override` (`work_id`);--> statement-breakpoint
CREATE INDEX `va_work_override_va_id_idx` ON `va_work_override` (`va_id`);--> statement-breakpoint
CREATE INDEX `works_release_idx` ON `works` (`release`) WHERE "works"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `works_dl_count_idx` ON `works` (`dl_count`) WHERE "works"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `works_price_idx` ON `works` (`price`) WHERE "works"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `works_rate_average_2dp_idx` ON `works` (`rate_average_2dp`) WHERE "works"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `works_review_count_idx` ON `works` (`review_count`) WHERE "works"."deleted_at" is null;--> statement-breakpoint
CREATE VIEW `v_tag_work` AS 
  SELECT o.work_id AS work_id, o.tag_id AS tag_id
    FROM tag_work_override o
   WHERE o.action = 'add'
  UNION
  SELECT w.work_id AS work_id, w.tag_id AS tag_id
    FROM tag_work w
   WHERE NOT EXISTS (
           SELECT 1 FROM work_meta_overrides m
            WHERE m.work_id = w.work_id AND m.tags_cleared = 1
         )
     AND NOT EXISTS (
           SELECT 1 FROM tag_work_override o
            WHERE o.work_id = w.work_id AND o.tag_id = w.tag_id
              AND o.action = 'remove'
         )
;--> statement-breakpoint
CREATE VIEW `v_va_work` AS 
  SELECT o.work_id AS work_id, o.va_id AS va_id
    FROM va_work_override o
   WHERE o.action = 'add'
  UNION
  SELECT w.work_id AS work_id, w.va_id AS va_id
    FROM va_work w
   WHERE NOT EXISTS (
           SELECT 1 FROM work_meta_overrides m
            WHERE m.work_id = w.work_id AND m.vas_cleared = 1
         )
     AND NOT EXISTS (
           SELECT 1 FROM va_work_override o
            WHERE o.work_id = w.work_id AND o.va_id = w.va_id
              AND o.action = 'remove'
         )
;--> statement-breakpoint
CREATE VIEW `v_work` AS 
  SELECT w.id AS work_id,
         COALESCE(m.title, w.title) AS title,
         COALESCE(m.circle_id, w.circle_id) AS circle_id,
         COALESCE(m.series_id, w.series_id) AS series_id,
         COALESCE(m.age_rating, w.age_rating) AS age_rating
    FROM works w
    LEFT JOIN work_meta_overrides m ON m.work_id = w.id
   WHERE w.deleted_at IS NULL
;