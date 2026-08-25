// 作品源分发：目录 → folder；.tar → tar source；.zip → zip source。
import { statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createFolderSource } from './folder.js';
import { UnsupportedArchiveError, type WorkSource } from './types.js';

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
  if (ext === '.tar') {
    // TODO: Task 4 实现后恢复
    // const { createTarSource } = await import('./tar.js');
    // return await createTarSource(fullPath);
    throw new UnsupportedArchiveError(workDir, 'tar 支持尚未实现');
  }
  if (ext === '.zip') {
    // TODO: Task 5 实现后恢复
    // const { createZipSource } = await import('./zip.js');
    // return await createZipSource(fullPath);
    throw new UnsupportedArchiveError(workDir, 'zip 支持尚未实现');
  }
  throw new UnsupportedArchiveError(
    workDir,
    '不是 tar / stored zip 格式的作品包',
  );
}
