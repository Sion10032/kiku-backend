import { sqliteTable, text, integer, blob, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * 通用二进制存储表（blob.db）
 * 封面等二进制数据以 namespace + key 定位，data 存原始字节
 */
export const blobs = sqliteTable('blobs', {
  namespace: text('namespace').notNull(),
  key: text('key').notNull(),
  mimeType: text('mime_type'),
  size: integer('size').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, t => [ primaryKey({ columns: [ t.namespace, t.key ] }) ]);
