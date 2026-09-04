import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';
import { hashPassword } from './utils.js';

/**
 * 从环境变量初始化管理员账号。
 *
 * KIKU_ADMIN_USER / KIKU_ADMIN_PASSWORD 两者需同时设置：
 * - 均设置 + 用户表为空 → 创建 administrator 用户
 * - 均设置 + 用户表非空 → 跳过（不覆盖既有用户）
 * - 只设置其一 / 格式非法 → 抛错（启动显式失败）
 */
export async function initAdminFromEnv(): Promise<void> {
  const user = process.env.KIKU_ADMIN_USER;
  const password = process.env.KIKU_ADMIN_PASSWORD;

  if (!user && !password) return;

  if (!user || !password) {
    throw new Error(
      'KIKU_ADMIN_USER 与 KIKU_ADMIN_PASSWORD 必须同时设置（当前仅设置了其一）',
    );
  }

  if (user.length < 4) {
    throw new Error('KIKU_ADMIN_USER 格式非法：用户名长度至少 4 个字符');
  }
  if (password.length < 5) {
    throw new Error('KIKU_ADMIN_PASSWORD 格式非法：密码长度至少 5 个字符');
  }

  const existing = await db.query.users.findMany({
    columns: { name: true },
  });
  if (existing.length > 0) {
    console.log('[init] 用户表非空，跳过环境变量管理员初始化');
    return;
  }

  await db.insert(users).values({
    name: user,
    password: hashPassword(password),
    group: 'administrator',
  });

  console.log(`[init] 已从环境变量创建管理员用户: ${user}`);
}
