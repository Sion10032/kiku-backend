import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/main/index.js';
import { settingsBackups } from '../db/main/schema.js';

/** 备份列表项（不含 payload，列表轻量）。 */
export interface SettingsBackupSummaryDto {
  name: string;
  updatedAt: string;
}

/** 备份详情。 */
export interface SettingsBackupDetailDto {
  name: string;
  payload: string; // JSON 文本，前端 parse
  updatedAt: string;
}

/** 每用户备份上限。 */
export const SETTINGS_BACKUP_LIMIT = 10;

/** 按 (userName, name) 查备份完整行。 */
function findBackup(userName: string, name: string) {
  return db.query.settingsBackups.findFirst({
    where: { userName: userName, name: name },
  });
}

/** 列表按 updatedAt 倒序（最近备份在前）。 */
export async function listSettingBackups(
  userName: string,
): Promise<{ backups: SettingsBackupSummaryDto[] }> {
  const rows = await db
    .select({
      name: settingsBackups.name,
      updatedAt: settingsBackups.updatedAt,
    })
    .from(settingsBackups)
    .where(eq(settingsBackups.userName, userName))
    .orderBy(desc(settingsBackups.updatedAt));
  return { backups: rows };
}

/** 不存在返回 null。 */
export async function getSettingBackup(
  userName: string,
  name: string,
): Promise<SettingsBackupDetailDto | null> {
  const row = await findBackup(userName, name);
  if (!row) return null;
  return { name: row.name, payload: row.payload, updatedAt: row.updatedAt };
}

/** upsert；新建时若已达上限返回 false（路由转 409），覆盖更新不受限。 */
export async function upsertSettingBackup(
  userName: string,
  name: string,
  payload: string,
): Promise<boolean> {
  const existing = await findBackup(userName, name);
  if (!existing) {
    // 仅新建计入上限；同名覆盖更新不受限
    const [row] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(settingsBackups)
      .where(eq(settingsBackups.userName, userName));
    if ((row?.count ?? 0) >= SETTINGS_BACKUP_LIMIT) return false;
  }
  const now = new Date().toISOString();
  await db
    .insert(settingsBackups)
    .values({ userName, name, payload, updatedAt: now })
    .onConflictDoUpdate({
      target: [settingsBackups.userName, settingsBackups.name],
      set: { payload, updatedAt: now },
    });
  return true;
}

/** upsert + 回读组装详情（成功后必然存在；不可达分支抛错兼作类型收窄） */
export async function upsertBackupAndReturn(
  userName: string,
  name: string,
  payloadJson: string,
): Promise<'limit-reached' | SettingsBackupDetailDto> {
  const ok = await upsertSettingBackup(userName, name, payloadJson);
  if (!ok) return 'limit-reached';
  const backup = await getSettingBackup(userName, name);
  if (!backup) {
    throw new Error(
      `unreachable: upsert succeeded but backup missing (${name})`,
    );
  }
  return backup;
}

/** 删除备份（幂等，删不存在不报错）。 */
export async function deleteSettingBackup(
  userName: string,
  name: string,
): Promise<void> {
  await db
    .delete(settingsBackups)
    .where(
      and(
        eq(settingsBackups.userName, userName),
        eq(settingsBackups.name, name),
      ),
    );
}
