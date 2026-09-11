ALTER TABLE `t_track` ADD `loudness_lufs` real;--> statement-breakpoint
ALTER TABLE `t_track` ADD `loudness_true_peak_db` real;--> statement-breakpoint
ALTER TABLE `t_track` ADD `analyzed_at` text;--> statement-breakpoint
ALTER TABLE `t_track` ADD `analyze_error` text;--> statement-breakpoint
ALTER TABLE `t_track` ADD `loudness_curve` text;--> statement-breakpoint
ALTER TABLE `t_work` ADD `loudness_lufs` real;--> statement-breakpoint
ALTER TABLE `t_work` ADD `loudness_true_peak_db` real;