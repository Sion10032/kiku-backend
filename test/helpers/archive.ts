// 确定性字节级 fixture 构造器：不依赖系统 tar/zip 二进制。

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 2, '0');
}

/** 拼一个 512B tar 头。opts.prefix 为 ustar prefix；opts.type 覆盖 typeflag。 */
function tarHeader(
  name: string,
  size: number,
  opts?: { type?: string; prefix?: string; long?: boolean },
): Buffer {
  const buf = Buffer.alloc(512);
  const nameField = opts?.long === true ? 'dummy' : name;
  buf.write(nameField.slice(0, 99), 0, 'utf8');
  buf.write(`${octal(size, 12)}\0 `, 124, 'ascii'); // size
  buf.write('        ', 148, 'ascii'); // chksum 先填空格
  buf.write(opts?.type ?? '0', 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  if (opts?.prefix) buf.write(opts.prefix.slice(0, 154), 345, 'utf8');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return buf;
}

function pad512(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rem);
}

export function buildTar(
  entries: Array<{
    path: string;
    data?: Buffer | string;
    type?: 'file' | 'dir';
    prefix?: string;
  }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.type === 'dir' ? Buffer.alloc(0) : Buffer.from(e.data ?? '');
    const hdr =
      e.type === 'dir'
        ? tarHeader(e.path.endsWith('/') ? e.path : `${e.path}/`, 0, {
            type: '5',
          })
        : tarHeader(
            e.prefix ? e.path.slice(e.prefix.length + 1) : e.path,
            data.length,
            { prefix: e.prefix },
          );
    parts.push(hdr, data, pad512(data));
  }
  parts.push(Buffer.alloc(1024)); // 结尾双零块
  return Buffer.concat(parts);
}
