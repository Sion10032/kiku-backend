import { hashPassword, verifyPassword } from '../auth/utils.js';
import { getConfig, updateConfig } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import {
  findAnyUser,
  findUserByName,
  getUserByName,
  insertUser,
  updateGroup,
  updatePassword,
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

/** 注册：用户表为空 → 豁免 allowRegistration 开关，首个注册者成为 administrator；
 * 非空 → 按开关放行，新户为 user。重名交给数据库唯一约束判定。
 *
 * 「判定是否首个用户 + 建户」必须在同一事务内：否则两个并发注册可能都拿到
 * administrator（或都拿到 user 而永久没有管理员）。
 * bun:sqlite 是同步驱动，事务回调同步执行，因此函数体内在 db.transaction 之前
 * 不得出现 await（否则事务会在 await 处提前 commit）。 */
export async function register(
  name: string,
  password: string,
): Promise<RegisterResult> {
  const hash = hashPassword(password);
  return db.transaction((tx) => {
    const existing = findAnyUser(tx);
    if (existing && !getConfig().allowRegistration) {
      return { ok: false, reason: 'registration-disabled' } as const;
    }
    const created = insertUser(tx, {
      name,
      password: hash,
      group: existing ? 'user' : 'administrator',
    });
    if (!created) return { ok: false, reason: 'name-taken' } as const;
    return { ok: true, user: { name: created.name, group: created.group } };
  });
}

/** 首次初始化：建管理员 + 写实例配置。
 * 用户表空 → 新建；非空但来自 kikoeru 迁移（config 有标记且未消费）→ 同名改密提权 / 不同名新建，
 * 成功后写入 kikoeruSetupConsumed，此后迁移分支不可再用（一次性消费，防无限期重置提权）；
 * 其余（真已初始化 / 已消费）返回 null（route 映射 403）。
 *
 * 用户操作在单一同步事务内完成：bun:sqlite 同步驱动下「判定 + 建户/提权」原子化，
 * 与 register() 串行化——空库上 setup 与 register 交错不再可能产生双管理员。
 * 迁移标记判断提前到事务前（事务内无 config 依赖）；事务前不得出现 await。 */
export async function setupInstance(input: {
  name: string;
  password: string;
  instanceMode: 'private' | 'public';
  allowRegistration: boolean;
}): Promise<AuthUser | null> {
  const hash = hashPassword(input.password);
  const migrated =
    Boolean(getConfig().kikoeruMigratedAt) && !getConfig().kikoeruSetupConsumed;
  const ok = db.transaction((tx): boolean => {
    if (!findAnyUser(tx)) {
      // 未初始化：建首个管理员。防御：事务内串行，undefined 不应发生，按已初始化处理
      if (
        !insertUser(tx, {
          name: input.name,
          password: hash,
          group: 'administrator',
        })
      ) {
        return false;
      }
    } else if (migrated) {
      const same = findUserByName(tx, input.name);
      if (same) {
        // 同名：改密提权（updatePassword 内 bump tokenVersion 吊销旧 token）
        updatePassword(tx, input.name, hash);
        if (same.group !== 'administrator') {
          updateGroup(tx, input.name, 'administrator');
        }
      } else if (
        !insertUser(tx, {
          name: input.name,
          password: hash,
          group: 'administrator',
        })
      ) {
        // 不同名新建；undefined = name 冲突 → 按已初始化处理
        return false;
      }
    } else {
      // 真已初始化 / 迁移已消费
      return false;
    }
    return true;
  });
  if (!ok) return null;
  updateConfig({
    instanceMode: input.instanceMode,
    allowRegistration: input.allowRegistration,
    // 迁移分支的一次性消费：此后 /api/setup 对迁移用户永久关闭
    kikoeruSetupConsumed: true,
  });
  return { name: input.name, group: 'administrator' };
}
