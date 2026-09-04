CREATE TABLE `t_settings_backup` (
	`user_name` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `t_settings_backup_pk` PRIMARY KEY(`user_name`, `name`),
	CONSTRAINT `fk_t_settings_backup_user_name_t_user_name_fk` FOREIGN KEY (`user_name`) REFERENCES `t_user`(`name`) ON DELETE CASCADE
);
