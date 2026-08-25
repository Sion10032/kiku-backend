// 作品源分发：目录 → folder；.tar → tar source；.zip → zip source。
import { statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createFolderSource } from './folder.js';
import { createTarSource } from './tar.js';
import { UnsupportedArchiveError, type WorkSource } from './types.js';
import { createZipSource } from './zip.js';

export async function openWorkSource(
  rootFolderPath: string,
  workDir: string,
): Promise<WorkSource> {
  const fullPath = join(rootFolderPath, workDir);
  let isDir: boolean;
  try {
    isDir = statSync(fullPath).isDirectory();
  } catch {
    throw new Error(`work path not found: ${workDir}`);
  }
  if (isDir) return createFolderSource(fullPath);

  const ext = extname(fullPath).toLowerCase();
  if (ext === '.tar') return await createTarSource(fullPath);
  if (ext === '.zip') return await createZipSource(fullPath);
  throw new UnsupportedArchiveError(
    workDir,
    '不是 tar / stored zip 格式的作品包',
  );
}
