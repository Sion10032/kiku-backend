import { hashPassword, verifyPassword } from '../auth/utils.js';
import { getConfig, updateConfig } from '../config/index.js';
import { createUser, getUserByName, getUsers } from './user.service.js';

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

/** 首次初始化：建管理员 + 写实例配置；已初始化返回 null（route 映射 403） */
export async function setupInstance(input: {
  name: string;
  password: string;
  instanceMode: 'private' | 'public';
  allowRegistration: boolean;
}): Promise<AuthUser | null> {
  const existing = await getUsers();
  if (existing.length > 0) return null;
  await createUser({
    name: input.name,
    password: hashPassword(input.password),
    group: 'administrator',
  });
  updateConfig({
    instanceMode: input.instanceMode,
    allowRegistration: input.allowRegistration,
  });
  return { name: input.name, group: 'administrator' };
}
