CREATE TABLE `t_track` (
	`work_id` text NOT NULL,
	`media_index` text NOT NULL,
	`title` text NOT NULL,
	`duration_sec` real,
	`size_bytes` integer NOT NULL,
	CONSTRAINT `t_track_pk` PRIMARY KEY(`work_id`, `media_index`),
	CONSTRAINT `fk_t_track_work_id_t_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON DELETE CASCADE
);
