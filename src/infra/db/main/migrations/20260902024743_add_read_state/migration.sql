CREATE TABLE `t_read_state` (
	`user_name` text NOT NULL,
	`work_id` text NOT NULL,
	`read_at` text NOT NULL,
	CONSTRAINT `t_read_state_pk` PRIMARY KEY(`user_name`, `work_id`),
	CONSTRAINT `fk_t_read_state_user_name_t_user_name_fk` FOREIGN KEY (`user_name`) REFERENCES `t_user`(`name`) ON DELETE CASCADE,
	CONSTRAINT `fk_t_read_state_work_id_t_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `t_work`(`id`) ON DELETE CASCADE
);
