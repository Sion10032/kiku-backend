CREATE INDEX `r_tag_work_work_id_idx` ON `r_tag_work` (`work_id`);--> statement-breakpoint
CREATE INDEX `r_va_work_work_id_idx` ON `r_va_work` (`work_id`);--> statement-breakpoint
CREATE INDEX `t_work_release_idx` ON `t_work` (`release`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_dl_count_idx` ON `t_work` (`dl_count`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_price_idx` ON `t_work` (`price`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_rate_average_2dp_idx` ON `t_work` (`rate_average_2dp`) WHERE "t_work"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `t_work_review_count_idx` ON `t_work` (`review_count`) WHERE "t_work"."deleted_at" is null;