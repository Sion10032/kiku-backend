import { describe, expect, it } from 'bun:test';
import {
  entriesToTrackTree,
  isAudioFile,
  isSupportedFile,
  rekeyStrippedTopDir,
  stripCommonTopDir,
  treeHasAudio,
} from '../src/filesystem/source/tree.js';

describe('entriesToTrackTree', () => {
  it('根目录文件生成 audio/text/image/other 叶节点，hash 为相对路径', () => {
    const tree = entriesToTrackTree([
      'a.mp3',
      'b.txt',
      'c.jpg',
      'd.xyz', // 不支持扩展名不该出现在入参里，但函数容错跳过
    ]);
    // 注意：入参应已过滤；容错行为 = 跳过不支持扩展名
    expect(tree).toEqual([
      { type: 'audio', title: 'a.mp3', hash: 'a.mp3' },
      { type: 'text', title: 'b.txt', hash: 'b.txt' },
      { type: 'image', title: 'c.jpg', hash: 'c.jpg' },
    ]);
  });

  it('子目录文件嵌套为 folder 节点，文件夹排前、文件排后', () => {
    const tree = entriesToTrackTree(['b.mp3', 'sub/a.mp3', 'sub2/c.mp3']);
    expect(tree.map((n) => n.type)).toEqual(['folder', 'folder', 'audio']);
    const sub = tree[0];
    expect(
      sub?.type === 'folder' &&
        sub.title === 'sub' &&
        sub.children?.length === 1,
    ).toBe(true);
  });

  it('深层嵌套路径逐层建 folder', () => {
    const tree = entriesToTrackTree(['a/b/c/d.mp3']);
    let node = tree[0];
    expect(node?.type).toBe('folder');
    for (const name of ['a', 'b', 'c']) {
      if (node?.type !== 'folder') throw new Error(`expect folder ${name}`);
      expect(node.title).toBe(name);
      expect(node.children?.length).toBe(1);
      node = node.children[0];
    }
    expect(node?.type === 'audio' && node.hash === 'a/b/c/d.mp3').toBe(true);
  });

  it('排序：文件夹在前、文件在后，同级按字节序 .sort()', () => {
    const tree = entriesToTrackTree(['z.mp3', 'Z.mp3', 'a/x.mp3']);
    // 文件夹 a 排前；文件按字节序：'Z'(0x5A) < 'z'(0x7A)
    expect(tree.map((n) => n.title)).toEqual(['a', 'Z.mp3', 'z.mp3']);
  });

  it('treeHasAudio 递归发现任意层音频', () => {
    const tree = entriesToTrackTree(['a/b/c.txt', 'd.png']);
    expect(treeHasAudio(tree)).toBe(false);
    expect(treeHasAudio(entriesToTrackTree(['a/b/c.mp3']))).toBe(true);
  });

  it('扩展名判定（大小写不敏感）', () => {
    expect(isAudioFile('x.MP3')).toBe(true);
    expect(isAudioFile('x.flac')).toBe(true);
    expect(isAudioFile('x.txt')).toBe(false);
    expect(isSupportedFile('x.lrc')).toBe(true);
    expect(isSupportedFile('x.doc')).toBe(false);
  });
});

describe('stripCommonTopDir', () => {
  it('单层包装目录剥离', () => {
    expect(
      stripCommonTopDir(['RJ123456/01.mp3', 'RJ123456/sub/02.wav']),
    ).toEqual(['01.mp3', 'sub/02.wav']);
  });

  it('递归剥到根级为止（剥到没有单一顶层目录）', () => {
    expect(stripCommonTopDir(['a/b/01.mp3'])).toEqual(['01.mp3']);
    expect(stripCommonTopDir(['a/b/01.mp3', 'a/b/02.mp3'])).toEqual([
      '01.mp3',
      '02.mp3',
    ]);
  });

  it('剥到顶层不再唯一即停', () => {
    expect(stripCommonTopDir(['a/x/01.mp3', 'a/y/02.mp3'])).toEqual([
      'x/01.mp3',
      'y/02.mp3',
    ]);
  });

  it('顶层有根级文件（支持扩展名）时阻塞剥离', () => {
    expect(stripCommonTopDir(['cover.jpg', 'album/01.mp3'])).toEqual([
      'cover.jpg',
      'album/01.mp3',
    ]);
  });

  it('顶层有多个目录时不剥离', () => {
    expect(stripCommonTopDir(['a/01.mp3', 'b/02.mp3'])).toEqual([
      'a/01.mp3',
      'b/02.mp3',
    ]);
  });

  it('根级不支持文件不阻塞剥离，未共享前缀的条目保持原路径', () => {
    expect(stripCommonTopDir(['album/01.mp3', '.DS_Store'])).toEqual([
      '01.mp3',
      '.DS_Store',
    ]);
    expect(stripCommonTopDir(['album/01.mp3', '__MACOSX/._01'])).toEqual([
      '01.mp3',
      '__MACOSX/._01',
    ]);
  });

  it('空列表与无支持文件时原样返回', () => {
    expect(stripCommonTopDir([])).toEqual([]);
    expect(stripCommonTopDir(['junk/a.xyz'])).toEqual(['junk/a.xyz']);
  });

  it('文件已在根级时原样返回', () => {
    expect(stripCommonTopDir(['01.mp3'])).toEqual(['01.mp3']);
  });
});

describe('rekeyStrippedTopDir', () => {
  it('剥离顶层目录并重建 key，保留原条目', () => {
    const m = new Map([
      ['RJ1/01.mp3', 1],
      ['RJ1/sub/02.wav', 2],
    ]);
    const out = rekeyStrippedTopDir(m);
    expect([...out.keys()]).toEqual(['01.mp3', 'sub/02.wav']);
    expect(out.get('01.mp3')).toBe(1);
    expect(out.get('sub/02.wav')).toBe(2);
  });

  it('无需剥离时返回原 Map 引用', () => {
    const m = new Map([['01.mp3', 1]]);
    expect(rekeyStrippedTopDir(m)).toBe(m);
  });
});
