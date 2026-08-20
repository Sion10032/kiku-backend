/**
 * 临时：向 t_user 插入测试用户（与后端 hashPassword 同算法：md5(password + md5secret)）。
 *
 * 运行：bun run scripts/create-test-users.ts
 * 可重复执行（用户存在则重置为脚本内密码）。
 *
 * 注意：md5secret 从后端实际加载的 data/config.json 读取
 * （CONFIG_PATH 环境变量可覆盖，与 src/config/index.ts 同源），
 * 不要用根目录 config.json——那是测试 setup 生成的，secret 不同。
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';

const CONFIG_PATH = process.env.CONFIG_PATH || './data/config.json';

if (!existsSync(CONFIG_PATH)) {
  console.error(`配置不存在: ${CONFIG_PATH}（请先启动一次后端生成配置）`);
  process.exit(1);
}

const { md5secret } = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as {
  md5secret: string;
};

function hashPassword(password: string): string {
  return createHash('md5').update(password + md5secret).digest('hex');
}

const db = new Database('./data/sqlite/kiku.db');

/** 测试用户清单：一个管理员 + 两个普通用户 */
const USERS = [
  { name: 'admin', password: 'admin12345', group: 'administrator' },
  { name: 'tester', password: 'tester12345', group: 'user' },
  { name: 'alice', password: 'alice12345', group: 'user' },
];

for (const u of USERS) {
  db.run(
    'INSERT INTO t_user (name, password, "group") VALUES (?, ?, ?) ' +
      'ON CONFLICT(name) DO UPDATE SET password = excluded.password, "group" = excluded."group"',
    [u.name, hashPassword(u.password), u.group],
  );
  console.log(`已写入: ${u.name} / ${u.password} (${u.group})`);
}

db.close();
