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

/** 拼一个最小合法 zip（无 zip64）。method=8 用于测「deflate 拒绝」。 */
export function buildZip(
  entries: Array<{
    path: string | Buffer;
    data?: Buffer | string;
    method?: 0 | 8;
    efs?: boolean;
    flags?: number;
  }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const name = Buffer.isBuffer(e.path) ? e.path : Buffer.from(e.path, 'utf8');
    const method = e.method ?? 0;
    const flags = (e.efs ? 0x800 : 0) | (e.flags ?? 0);
    const crcVal = crc32(data);
    // local header
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crcVal, 14);
    local.writeUInt32LE(data.length, 18); // compSize
    local.writeUInt32LE(data.length, 22); // uncompSize
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);
    // central directory entry
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crcVal, 16);
    central.writeUInt32LE(data.length, 20); // compSize
    central.writeUInt32LE(data.length, 24); // uncompSize
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extraLen
    central.writeUInt16LE(0, 32); // commentLen
    central.writeUInt32LE(offset, 42); // localHeaderOffset
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  // EOCD (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(Buffer.concat(locals).length, 16); // cdOffset
  return Buffer.concat([...locals, cd, eocd]);
}
