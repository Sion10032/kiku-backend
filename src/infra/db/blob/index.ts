import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getConfig } from '../../config/index.js';
import { blobs } from './schema.js';

/**
 * 通用二进制存储（独立 blob.db）
 * 与元数据库 kiku.db 分离：大 BLOB 不拖慢主库，备份/VACUUM 独立
 */

// 获取二进制数据库路径（与主库同目录）
function getBlobDatabasePath(): string {
  const config = getConfig();
  const workDir = process.env.WORK_DIR || process.cwd();
  const dbDir = config.databaseFolderDir.startsWith('/')
    ? config.databaseFolderDir
    : join(workDir, config.databaseFolderDir);

  // 确保数据库目录存在
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  return join(dbDir, 'blob.db');
}

const blobSqlite = new Database(getBlobDatabasePath(), {
  strict: true,
});

blobSqlite.exec('PRAGMA journal_mode = WAL');
blobSqlite.exec('PRAGMA busy_timeout = 1000');

export const blobDb = drizzle({ client: blobSqlite });

// 启动时应用待处理迁移（经 __drizzle_migrations 表幂等）
migrate(blobDb, { migrationsFolder: './src/infra/db/blob/migrations' });

/**
 * 已存储的二进制记录
 */
export interface BlobRecord {
  data: Buffer;
  mimeType: string | null;
  size: number;
}

/**
 * 写入（或覆盖）一条二进制记录
 * @param namespace 命名空间（如 'cover'）
 * @param key 记录键
 * @param data 原始字节
 * @param mimeType 可选的 MIME 类型
 */
export function putBlob(
  namespace: string,
  key: string,
  data: Buffer,
  mimeType?: string,
): void {
  const mime = mimeType ?? null;
  blobDb
    .insert(blobs)
    .values({ namespace, key, data, mimeType: mime, size: data.byteLength })
    .onConflictDoUpdate({
      target: [blobs.namespace, blobs.key],
      set: {
        data,
        mimeType: mime,
        size: data.byteLength,
        createdAt: sql`(datetime('now'))`,
      },
    })
    .run();
}

/**
 * 读取一条二进制记录
 * @returns 记录（含字节、MIME、大小），不存在则返回 null
 */
export function getBlob(namespace: string, key: string): BlobRecord | null {
  const row = blobDb
    .select()
    .from(blobs)
    .where(and(eq(blobs.namespace, namespace), eq(blobs.key, key)))
    .get();
  if (!row) {
    return null;
  }
  return { data: row.data, mimeType: row.mimeType, size: row.size };
}

/**
 * 检查记录是否存在
 */
export function blobExists(namespace: string, key: string): boolean {
  const row = blobDb
    .select({ key: blobs.key })
    .from(blobs)
    .where(and(eq(blobs.namespace, namespace), eq(blobs.key, key)))
    .get();
  return row !== undefined;
}

/**
 * 删除一条记录
 * @returns 是否真的删除了一行
 */
export function deleteBlob(namespace: string, key: string): boolean {
  const result = blobDb
    .delete(blobs)
    .where(and(eq(blobs.namespace, namespace), eq(blobs.key, key)))
    .run();
  return result.changes > 0;
}
