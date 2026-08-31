// Readable 必须是值导入：readRange 内会 new Readable（简报原稿的 import type 会在运行时抛 ReferenceError）
import { Readable } from 'node:stream';
import type { WorkSource } from '../../src/filesystem/source/types.js';

/** 内存 WorkSource：Map<hash, Buffer>，readRange 语义与真实源一致。 */
export function memorySource(
  files: Record<string, Buffer | string>,
): WorkSource {
  const map = new Map(
    Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]),
  );
  return {
    kind: 'folder',
    async buildTree() {
      throw new Error('not needed');
    },
    async has(hash) {
      return map.has(hash);
    },
    async size(hash) {
      const b = map.get(hash);
      if (!b) throw new Error(`no entry: ${hash}`);
      return b.length;
    },
    async readRange(hash, start, end) {
      const b = map.get(hash);
      if (!b) throw new Error(`no entry: ${hash}`);
      const slice = b.subarray(start, end + 1);
      const stream = new Readable({
        read() {
          stream.push(slice);
          stream.push(null);
        },
      });
      return stream;
    },
  };
}
