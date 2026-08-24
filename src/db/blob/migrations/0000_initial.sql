CREATE TABLE `blobs` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`mime_type` text,
	`size` integer NOT NULL,
	`data` blob NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`namespace`, `key`)
);
