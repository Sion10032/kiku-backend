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

/** 注册：allowRegistration 开关 → 建户（密码 hash 在此完成）。
 * 重名交给数据库唯一约束判定（先查后插有 TOCTOU 竞态），createUser 返回 undefined 即 name-taken。 */
export async function register(
  name: string,
  password: string,
): Promise<RegisterResult> {
  if (!getConfig().allowRegistration) {
    return { ok: false, reason: 'registration-disabled' };
  }
  const created = await createUser({
    name,
    password: hashPassword(password),
    group: 'user',
  });
  if (!created) {
    return { ok: false, reason: 'name-taken' };
  }
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
    const created = await createUser({
      name: input.name,
      password: hashPassword(input.password),
      group: 'administrator',
    });
    // undefined = 并发 /api/setup 已抢先建户 → 视为已初始化（route 映射 403）
    if (!created) return null;
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
      const created = await createUser({
        name: input.name,
        password: hashPassword(input.password),
        group: 'administrator',
      });
      // 同上：并发下已被别的请求建户，按已初始化处理
      if (!created) return null;
    }
  } else {
    return null;
  }
  updateConfig({
    instanceMode: input.instanceMode,
    allowRegistration: input.allowRegistration,
    // 迁移分支的一次性消费：此后 /api/setup 对迁移用户永久关闭
    kikoeruSetupConsumed: true,
  });
  return { name: input.name, group: 'administrator' };
}
