import { hashPassword, verifyPassword } from '../auth/utils.js';
import { getConfig, updateConfig } from '../infra/config/index.js';
import {
  createUser,
  getUserByName,
  getUsers,
  updateUserGroup,
  updateUserPassword,
} from './user.service.js';

export interface AuthUser {
  name: string;
  group: string;
}

/** 验证凭据；通过返回用户（route 负责签 token），失败返回 null（route 映射 401） */
export async function login(
  name: string,
  password: string,
): Promise<AuthUser | null> {
  const user = await getUserByName(name);
  if (!user || !verifyPassword(password, user.password)) return null;
  return { name: user.name, group: user.group };
}

export type RegisterResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'registration-disabled' | 'name-taken' };

/** 注册：allowRegistration 开关 → 查重 → 建户（密码 hash 在此完成） */
export async function register(
  name: string,
  password: string,
): Promise<RegisterResult> {
  if (!getConfig().allowRegistration) {
    return { ok: false, reason: 'registration-disabled' };
  }
  if (await getUserByName(name)) {
    return { ok: false, reason: 'name-taken' };
  }
  await createUser({ name, password: hashPassword(password), group: 'user' });
  return { ok: true, user: { name, group: 'user' } };
}

/** 首次初始化：建管理员 + 写实例配置。
 * 用户表空 → 新建；非空但来自 kikoeru 迁移（config 有标记且未消费）→ 同名改密提权 / 不同名新建，
 * 成功后写入 kikoeruSetupConsumed，此后迁移分支不可再用（一次性消费，防无限期重置提权）；
 * 其余（真已初始化 / 已消费）返回 null（route 映射 403）。 */
export async function setupInstance(input: {
  name: string;
  password: string;
  instanceMode: 'private' | 'public';
  allowRegistration: boolean;
}): Promise<AuthUser | null> {
  const existing = await getUsers();
  if (existing.length === 0) {
    await createUser({
      name: input.name,
      password: hashPassword(input.password),
      group: 'administrator',
    });
  } else if (
    getConfig().kikoeruMigratedAt && !getConfig().kikoeruSetupConsumed
  ) {
    const same = await getUserByName(input.name);
    if (same) {
      await updateUserPassword(input.name, hashPassword(input.password));
      if (same.group !== 'administrator') {
        await updateUserGroup(input.name, 'administrator');
      }
    } else {
      await createUser({
        name: input.name,
        password: hashPassword(input.password),
        group: 'administrator',
      });
    }
  } else {
    return null;
  }
  updateConfig({
    instanceMode: input.instanceMode,
    allowRegistration: input.allowRegistration,
    // 迁移分支的一次性消费：此后 /api/auth/setup 对迁移用户永久关闭
    kikoeruSetupConsumed: true,
  });
  return { name: input.name, group: 'administrator' };
}
