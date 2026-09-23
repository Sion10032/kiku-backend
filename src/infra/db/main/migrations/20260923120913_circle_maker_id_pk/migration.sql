-- 本迁移依赖连接在迁移期处于 foreign_keys=OFF（见 infra/db/main/index.ts：
-- migrate() 先于 PRAGMA foreign_keys = ON 执行）。迁移内写 PRAGMA 无效：
-- drizzle migrateSync 把每个迁移包在事务里，而 SQLite 的 foreign_keys pragma 在事务内是 no-op。
--
-- 重建前必须先摘掉引用被重建表的视图：SQLite ≥3.25 的 ALTER TABLE ... RENAME 会重新解析
-- 整个 schema，而 DROP TABLE 之后旧表上的视图成为悬空引用，RENAME 会以
-- "error in view v_work: no such table: main.t_work" 失败。migrateSync 把整份迁移包在
-- 一个事务里，失败即整体回滚（schema 与数据都不变），结果是这份迁移根本无法应用。
-- 三个视图的定义与 20260907123050_blue_ken_ellis 逐字节一致，文件末尾原样重建。
DROP VIEW `v_work`;--> statement-breakpoint
DROP VIEW `v_tag_work`;--> statement-breakpoint
DROP VIEW `v_va_work`;--> statement-breakpoint
CREATE TABLE `__new_t_work` (
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
	CONSTRAINT `fk_t_work_circle_id_t_circle_id_fk` FOREIGN KEY (`circle_id`) REFERENCES `t_circle`(`id`) ON UPDATE CASCADE,
	CONSTRAINT `fk_t_work_series_id_t_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `t_series`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_t_work`(`id`, `root_folder`, `dir`, `title`, `circle_id`, `age_rating`, `release`, `dl_count`, `price`, `review_count`, `rate_count`, `rate_average_2dp`, `rate_count_detail`, `rank`, `language`, `source_id`, `series_id`, `deleted_at`, `loudness_lufs`, `loudness_true_peak_db`) SELECT `id`, `root_folder`, `dir`, `title`, CAST(`circle_id` AS TEXT), `age_rating`, `release`, `dl_count`, `price`, `review_count`, `rate_count`, `rate_average_2dp`, `rate_count_detail`, `rank`, `language`, `source_id`, `series_id`, `deleted_at`, `loudness_lufs`, `loudness_true_peak_db` FROM `t_work`;--> statement-breakpoint
DROP TABLE `t_work`;--> statement-breakpoint
ALTER TABLE `__new_t_work` RENAME TO `t_work`;--> statement-breakpoint
CREATE TABLE `__new_t_circle` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_t_circle`(`id`, `name`) SELECT CAST(`id` AS TEXT), `name` FROM `t_circle`;--> statement-breakpoint
DROP TABLE `t_circle`;--> statement-breakpoint
ALTER TABLE `__new_t_circle` RENAME TO `t_circle`;--> statement-breakpoint
CREATE TABLE `__new_t_work_meta_override` (
	`work_id` text PRIMARY KEY,
	`title` text,
	`circle_id` text,
	`series_id` text,
	`age_rating` text,
	`tags_cleared` integer DEFAULT 0 NOT NULL,
	`vas_cleared` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	CONSTRAINT `fk_t_work_meta_override_work_id_t_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_t_work_meta_override_circle_id_t_circle_id_fk` FOREIGN KEY (`circle_id`) REFERENCES `t_circle`(`id`) ON UPDATE CASCADE,
	CONSTRAINT `fk_t_work_meta_override_series_id_t_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `t_series`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_t_work_meta_override`(`work_id`, `title`, `circle_id`, `series_id`, `age_rating`, `tags_cleared`, `vas_cleared`, `updated_by`, `updated_at`) SELECT `work_id`, `title`, CAST(`circle_id` AS TEXT), `series_id`, `age_rating`, `tags_cleared`, `vas_cleared`, `updated_by`, `updated_at` FROM `t_work_meta_override`;--> statement-breakpoint
DROP TABLE `t_work_meta_override`;--> statement-breakpoint
ALTER TABLE `__new_t_work_meta_override` RENAME TO `t_work_meta_override`;--> statement-breakpoint
CREATE INDEX `t_work_release_idx` ON `t_work` (`release`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_dl_count_idx` ON `t_work` (`dl_count`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_price_idx` ON `t_work` (`price`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_rate_average_2dp_idx` ON `t_work` (`rate_average_2dp`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_review_count_idx` ON `t_work` (`review_count`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
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