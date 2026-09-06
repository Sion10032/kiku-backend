import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { getConfig, updateConfig } from '../infra/config/index.js';
import type { Config } from '../infra/config/schema.js';
import { db } from '../infra/db/main/index.js';
import { putBlob } from '../infra/db/blob/index.js';
import {
  circles,
  readStates,
  reviews,
  tagWork,
  tags,
  users,
  vaWork,
  vas,
  works,
} from '../infra/db/main/schema.js';
import { extractWorkCode } from '../utils/rjcode.js';
import type { WorkRankEntry } from '../infra/scraper/dlsite.js';

/** kikoeru 旧数据目录（与 config.databaseFolderDir 同规则解析） */
export function getOldDataDir(): string {
  const workDir = process.env.WORK_DIR || process.cwd();
  return join(workDir, 'old-data');
}

export interface KikoeruStats {
  works: number;
  users: number;
  reviews: number;
  playHistory: number;
  covers: number;
}

export interface KikoeruDetection {
  flavor: 'number178-fork' | 'vanilla';
  stats: KikoeruStats;
}

/** 只读打开旧库（迁移绝不写旧库） */
function openOldDb(oldDataDir: string): Database | null {
  const dbPath = join(oldDataDir, 'sqlite', 'db.sqlite3');
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, strict: true });
  } catch {
    return null;
  }
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return row !== null;
}

function countRows(db: Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}

function countCovers(oldDataDir: string): number {
  const coversDir = join(oldDataDir, 'covers');
  if (!existsSync(coversDir)) return 0;
  return readdirSync(coversDir).filter((f) =>
    /^((?:RJ|VJ)\d+)_img_(\w+)\.jpe?g$/i.test(f),
  ).length;
}

/**
 * 探测 old-data：无 db.sqlite3 或缺核心表 → null；
 * 版本按 fork 特有标志判定（仅展示用，迁移逻辑按表探测不受影响）。
 */
export function detectKikoeruData(oldDataDir: string): KikoeruDetection | null {
  const db = openOldDb(oldDataDir);
  if (!db) return null;
  try {
    // 核心表缺失 → 不是 kikoeru 数据
    if (!tableExists(db, 't_work') || !tableExists(db, 't_user')) return null;

    const isFork =
      tableExists(db, 't_translate_task') || tableExists(db, 't_play_histroy');

    return {
      flavor: isFork ? 'number178-fork' : 'vanilla',
      stats: {
        works: countRows(db, 't_work'),
        users: countRows(db, 't_user'),
        reviews: countRows(db, 't_review'),
        playHistory: countRows(db, 't_play_histroy'),
        covers: countCovers(oldDataDir),
      },
    };
  } finally {
    db.close();
  }
}

export interface KikoeruMigrationStats {
  circles: number;
  works: number;
  worksSkipped: number; // dir 提取不出 RJ/VJ 码
  tags: number;
  vas: number;
  tagWork: number;
  vaWork: number;
  users: number;
  usersSkipped: number;
  reviews: number;
  reviewsSkipped: number; // workId 映射失败
  readStates: number;
  readStatesSkipped: number;
  coversImported: number;
}

export interface KikoeruMigrationResult {
  ok: boolean;
  error?: string; // ok=false 时的人类可读原因（中文）
  stats?: KikoeruMigrationStats;
}

interface OldRow {
  [key: string]: unknown;
}

/**
 * kikoeru 旧库 rate_count_detail 存的是 DLsite AJAX 原始数组 JSON：
 * [{ review_point, count, ratio }] → kiku 契约 record { "1": count, ... }（丢弃 ratio）。
 * 解析失败 / 形状不符 / 空对象 → null（与 scanner 空数据「不写」语义一致）。
 */
function normalizeRateCountDetail(raw: unknown): Record<string, number> | null {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Record<string, number> = {};
  for (const item of parsed) {
    const reviewPoint = (item as { review_point?: unknown })?.review_point;
    const count = (item as { count?: unknown })?.count;
    if (typeof count !== 'number') continue;
    if (typeof reviewPoint !== 'number' && typeof reviewPoint !== 'string') {
      continue;
    }
    out[String(reviewPoint)] = count;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * kikoeru 旧库 rank 存的是 DLsite AJAX 原始数组 JSON：
 * [{ term, category, rank, rank_date }]，kiku 契约为同形状原始数组（保留 rank_date）。
 * 逐项规范化：term/category 非空 string、rank number 才收；rank_date 缺省补 ''。
 * 解析失败 / 形状不符 / 空数组 → null。
 */
function normalizeRank(raw: unknown): WorkRankEntry[] | null {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: WorkRankEntry[] = [];
  for (const item of parsed) {
    const term = (item as { term?: unknown })?.term;
    const category = (item as { category?: unknown })?.category;
    const rank = (item as { rank?: unknown })?.rank;
    const rankDate = (item as { rank_date?: unknown })?.rank_date;
    if (typeof term !== 'string' || !term) continue;
    if (typeof category !== 'string' || !category) continue;
    if (typeof rank !== 'number') continue;
    out.push({
      term,
      category,
      rank,
      rank_date: typeof rankDate === 'string' ? rankDate : '',
    });
  }
  return out.length > 0 ? out : null;
}

/** 执行迁移：门禁校验 → 主库事务 → 封面导入 + config 副作用 */
export function migrateFromKikoeru(
  oldDataDir: string,
): KikoeruMigrationResult {
  const detection = detectKikoeruData(oldDataDir);
  if (!detection) {
    return {
      ok: false,
      error: '未找到可识别的 kikoeru 数据（old-data/sqlite/db.sqlite3）',
    };
  }

  // 门禁 1：已迁移过
  if (getConfig().kikoeruMigratedAt) {
    return { ok: false, error: '已迁移过 kikoeru 数据（config.kikoeruMigratedAt 已存在）' };
  }
  // 门禁 2：新库非空
  const workCount = db.select({ c: sql<number>`count(*)` }).from(works).get();
  if ((workCount?.c ?? 0) > 0) {
    return { ok: false, error: '当前数据库非空，仅支持在空库上执行迁移' };
  }

  const old = openOldDb(oldDataDir);
  if (!old) return { ok: false, error: '旧数据库无法打开' };

  const stats: KikoeruMigrationStats = {
    circles: 0,
    works: 0,
    worksSkipped: 0,
    tags: 0,
    vas: 0,
    tagWork: 0,
    vaWork: 0,
    users: 0,
    usersSkipped: 0,
    reviews: 0,
    reviewsSkipped: 0,
    readStates: 0,
    readStatesSkipped: 0,
    coversImported: 0,
  };

  try {
    db.transaction((tx) => {
      // 1) work id 映射：旧自增整数 → RJ/VJ 码（dir 提取，保持原样不规范化）
      const oldWorks = old.query('SELECT * FROM t_work').all() as OldRow[];
      const idMap = new Map<number, string>();
      for (const w of oldWorks) {
        const code = extractWorkCode(String(w.dir ?? ''));
        if (!code) {
          stats.worksSkipped++;
          continue;
        }
        idMap.set(Number(w.id), code);
      }

      // 2) 基础表（id 保留；ON CONFLICT 保留已有行）
      const circleRows = old
        .query('SELECT id, name FROM t_circle')
        .all() as OldRow[];
      if (circleRows.length) {
        tx.insert(circles)
          .values(circleRows.map((r) => ({ id: Number(r.id), name: String(r.name) })))
          .onConflictDoNothing()
          .run();
        stats.circles = circleRows.length;
      }

      const tagRows = old.query('SELECT id, name FROM t_tag').all() as OldRow[];
      if (tagRows.length) {
        tx.insert(tags)
          .values(tagRows.map((r) => ({ id: Number(r.id), name: String(r.name) })))
          .onConflictDoNothing()
          .run();
        stats.tags = tagRows.length;
      }

      const vaRows = old.query('SELECT id, name FROM t_va').all() as OldRow[];
      if (vaRows.length) {
        tx.insert(vas)
          .values(vaRows.map((r) => ({ id: String(r.id), name: String(r.name) })))
          .onConflictDoNothing()
          .run();
        stats.vas = vaRows.length;
      }

      // 3) works：ageRating 按旧库 nsfw 布尔列映射（真值 → 'r18'，假值/NULL → 'all'；
      //    旧库无 r15 信息不判定）；rescan 后 DLsite 元数据仍回写更精确的真实分级。
      //    rate_count_detail 归一化为 kiku record；rank 保留 DLsite 原始数组形状
      //    （含 rank_date），各自存 JSON 串
      const workValues = oldWorks
        .filter((w) => idMap.has(Number(w.id)))
        .map((w) => {
          const rateCountDetail = normalizeRateCountDetail(w.rate_count_detail);
          const rank = normalizeRank(w.rank);
          return {
            id: idMap.get(Number(w.id))!,
            rootFolder: String(w.root_folder),
            dir: String(w.dir),
            title: String(w.title),
            circleId: Number(w.circle_id),
            // nsfw 在 bun:sqlite 里是 0/1（可空）：真值 → 'r18'，假值/NULL → 'all'
            ageRating: (w.nsfw ? 'r18' : 'all') as 'r18' | 'all',
            release: (w.release as string | null) ?? null,
            dlCount: (w.dl_count as number | null) ?? null,
            price: (w.price as number | null) ?? null,
            reviewCount: (w.review_count as number | null) ?? null,
            rateCount: (w.rate_count as number | null) ?? null,
            rateAverage2dp: (w.rate_average_2dp as number | null) ?? null,
            rateCountDetail: rateCountDetail
              ? JSON.stringify(rateCountDetail)
              : null,
            rank: rank ? JSON.stringify(rank) : null,
          };
        });
      if (workValues.length) {
        tx.insert(works).values(workValues).onConflictDoNothing().run();
        stats.works = workValues.length;
      }

      // 4) 关联表：workId 重映射，映射失败跳过
      const twRows = old
        .query('SELECT tag_id, work_id FROM r_tag_work')
        .all() as OldRow[];
      const twValues = twRows.flatMap((r) => {
        const wid = idMap.get(Number(r.work_id));
        return wid ? [{ tagId: Number(r.tag_id), workId: wid }] : [];
      });
      if (twValues.length) {
        tx.insert(tagWork).values(twValues).onConflictDoNothing().run();
        stats.tagWork = twValues.length;
      }

      const vwRows = old
        .query('SELECT va_id, work_id FROM r_va_work')
        .all() as OldRow[];
      const vwValues = vwRows.flatMap((r) => {
        const wid = idMap.get(Number(r.work_id));
        return wid ? [{ vaId: String(r.va_id), workId: wid }] : [];
      });
      if (vwValues.length) {
        tx.insert(vaWork).values(vwValues).onConflictDoNothing().run();
        stats.vaWork = vwValues.length;
      }

      // 5) users：hash 原样（md5secret 由 Task 5 迁入 config 保兼容）；同名保留已有
      const userRows = old
        .query('SELECT name, password, "group" FROM t_user')
        .all() as OldRow[];
      let usersInserted = 0;
      for (const r of userRows) {
        const res = tx
          .insert(users)
          .values({
            name: String(r.name),
            password: String(r.password),
            group: String(r.group),
          })
          .onConflictDoNothing()
          .run();
        if (res.changes > 0) usersInserted++;
      }
      stats.users = usersInserted;
      stats.usersSkipped = userRows.length - usersInserted;

      // 6) reviews：work_id 是 varchar，Number() 后查映射
      const revRows = old.query('SELECT * FROM t_review').all() as OldRow[];
      const revValues = revRows.flatMap((r) => {
        const wid = idMap.get(Number(r.work_id));
        if (!wid) {
          stats.reviewsSkipped++;
          return [];
        }
        return [
          {
            userName: String(r.user_name),
            workId: wid,
            rating: (r.rating as number | null) ?? null,
            reviewText: (r.review_text as string | null) ?? null,
            createdAt: (r.created_at as string | null) ?? null,
            updatedAt: (r.updated_at as string | null) ?? null,
            progress: (r.progress as string | null) ?? null,
          },
        ];
      });
      if (revValues.length) {
        tx.insert(reviews).values(revValues).onConflictDoNothing().run();
        stats.reviews = revValues.length;
      }

      // 7) 播放历史 → 已读标记（fork 才有此表；位置信息按设计丢弃）
      if (tableExists(old, 't_play_histroy')) {
        const phRows = old
          .query(
            'SELECT user_name, work_id, created_at, updated_at FROM t_play_histroy',
          )
          .all() as OldRow[];
        const rsValues = phRows.flatMap((r) => {
          const wid = idMap.get(Number(r.work_id));
          if (!wid) {
            stats.readStatesSkipped++;
            return [];
          }
          return [
            {
              userName: String(r.user_name),
              workId: wid,
              readAt: String(r.updated_at ?? r.created_at ?? ''),
            },
          ];
        });
        if (rsValues.length) {
          tx.insert(readStates).values(rsValues).onConflictDoNothing().run();
          stats.readStates = rsValues.length;
        }
      }

    });

    // 封面导入（独立于主库事务；putBlob 幂等 upsert）
    const coversDir = join(oldDataDir, 'covers');
    if (existsSync(coversDir)) {
      for (const f of readdirSync(coversDir)) {
        const m = f.match(/^((?:RJ|VJ)\d+)_img_(\w+)\.jpe?g$/i);
        if (!m) continue;
        putBlob('cover', `${m[1]}_${m[2]}`, readFileSync(join(coversDir, f)), 'image/jpeg');
        stats.coversImported++;
      }
    }

    // config 副作用：md5secret 覆盖（保旧密码可用）+ rootFolders 按 name 合并 + 迁移标记
    const updates: Partial<Config> = {
      kikoeruMigratedAt: new Date().toISOString(),
    };
    const oldConfigPath = join(oldDataDir, 'config', 'config.json');
    if (existsSync(oldConfigPath)) {
      try {
        // 旧 config.json 是用户可手改的文件：值类型畸形按「不存在」跳过，
        // 避免 updateConfig 内 configSchema.parse 在主库事务提交后抛错 → 返回
        // ok=false 且门禁 2（works 非空）从此永久拒绝重跑（迁移砖死）
        const oldConfig = JSON.parse(readFileSync(oldConfigPath, 'utf-8')) as {
          md5secret?: unknown;
          rootFolders?: unknown;
        };
        if (typeof oldConfig.md5secret === 'string' && oldConfig.md5secret) {
          updates.md5secret = oldConfig.md5secret;
        }
        if (Array.isArray(oldConfig.rootFolders)) {
          const existingNames = new Set(
            getConfig().rootFolders.map((r) => r.name),
          );
          const additions = (oldConfig.rootFolders as unknown[])
            .filter(
              (r): r is { name: string; path: string } =>
                !!r &&
                typeof (r as { name?: unknown }).name === 'string' &&
                !!(r as { name?: unknown }).name &&
                typeof (r as { path?: unknown }).path === 'string',
            )
            .filter((r) => !existingNames.has(r.name));
          if (additions.length) {
            updates.rootFolders = [...getConfig().rootFolders, ...additions];
          }
        }
      } catch {
        // 旧 config 损坏不阻断迁移，仅跳过 config 副作用
      }
    }
    updateConfig(updates);

    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: `迁移失败：${String(err)}` };
  } finally {
    old.close();
  }
}
