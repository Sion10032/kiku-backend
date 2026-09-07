CREATE TABLE `r_tag_work_override` (
	`work_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	`action` text NOT NULL,
	CONSTRAINT `r_tag_work_override_pk` PRIMARY KEY(`work_id`, `tag_id`),
	CONSTRAINT `fk_r_tag_work_override_work_id_t_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_r_tag_work_override_tag_id_t_tag_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `t_tag`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `r_va_work_override` (
	`work_id` text NOT NULL,
	`va_id` text NOT NULL,
	`action` text NOT NULL,
	CONSTRAINT `r_va_work_override_pk` PRIMARY KEY(`work_id`, `va_id`),
	CONSTRAINT `fk_r_va_work_override_work_id_t_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_r_va_work_override_va_id_t_va_id_fk` FOREIGN KEY (`va_id`) REFERENCES `t_va`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `t_work_meta_override` (
	`work_id` text PRIMARY KEY,
	`title` text,
	`circle_id` integer,
	`series_id` text,
	`age_rating` text,
	`tags_cleared` integer DEFAULT 0 NOT NULL,
	`vas_cleared` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	CONSTRAINT `fk_t_work_meta_override_work_id_t_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_t_work_meta_override_circle_id_t_circle_id_fk` FOREIGN KEY (`circle_id`) REFERENCES `t_circle`(`id`),
	CONSTRAINT `fk_t_work_meta_override_series_id_t_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `t_series`(`id`)
);
--> statement-breakpoint
CREATE INDEX `r_tag_work_override_work_id_idx` ON `r_tag_work_override` (`work_id`);--> statement-breakpoint
CREATE INDEX `r_tag_work_override_tag_id_idx` ON `r_tag_work_override` (`tag_id`);--> statement-breakpoint
CREATE INDEX `r_va_work_override_work_id_idx` ON `r_va_work_override` (`work_id`);--> statement-breakpoint
CREATE INDEX `r_va_work_override_va_id_idx` ON `r_va_work_override` (`va_id`);--> statement-breakpoint
CREATE VIEW `v_tag_work` AS 
  SELECT o.work_id AS work_id, o.tag_id AS tag_id
    FROM r_tag_work_override o
   WHERE o.action = 'add'
  UNION
  SELECT w.work_id AS work_id, w.tag_id AS tag_id
    FROM r_tag_work w
   WHERE NOT EXISTS (
           SELECT 1 FROM t_work_meta_override m
            WHERE m.work_id = w.work_id AND m.tags_cleared = 1
         )
     AND NOT EXISTS (
           SELECT 1 FROM r_tag_work_override o
            WHERE o.work_id = w.work_id AND o.tag_id = w.tag_id
              AND o.action = 'remove'
         )
;--> statement-breakpoint
CREATE VIEW `v_va_work` AS 
  SELECT o.work_id AS work_id, o.va_id AS va_id
    FROM r_va_work_override o
   WHERE o.action = 'add'
  UNION
  SELECT w.work_id AS work_id, w.va_id AS va_id
    FROM r_va_work w
   WHERE NOT EXISTS (
           SELECT 1 FROM t_work_meta_override m
            WHERE m.work_id = w.work_id AND m.vas_cleared = 1
         )
     AND NOT EXISTS (
           SELECT 1 FROM r_va_work_override o
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
    FROM t_work w
    LEFT JOIN t_work_meta_override m ON m.work_id = w.id
   WHERE w.deleted_at IS NULL
;