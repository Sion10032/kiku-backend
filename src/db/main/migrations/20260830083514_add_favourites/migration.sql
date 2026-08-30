CREATE TABLE `t_favourite` (
	`user_name` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	CONSTRAINT `t_favourite_pk` PRIMARY KEY(`user_name`, `target_type`, `target_id`),
	CONSTRAINT `fk_t_favourite_user_name_t_user_name_fk` FOREIGN KEY (`user_name`) REFERENCES `t_user`(`name`) ON DELETE CASCADE
);
