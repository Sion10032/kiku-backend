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

  it('排序：文件夹在前、文件在后，同级按自然序（数字段按数值）', () => {
    const tree = entriesToTrackTree([
      '10.mp3',
      '2.mp3',
      '01.mp3',
      'b 10/a.mp3',
      'b 2/x.mp3',
    ]);
    // 文件夹排前且自然序：b 2 < b 10；文件自然序：01 < 2 < 10
    expect(tree.map((n) => n.title)).toEqual([
      'b 2',
      'b 10',
      '01.mp3',
      '2.mp3',
      '10.mp3',
    ]);
  });

  it('排序：非数字部分按 locale 序（ja：小写在前），数字段不受影响', () => {
    const tree = entriesToTrackTree(['z.mp3', 'Z.mp3', 'a/x.mp3']);
    expect(tree.map((n) => n.title)).toEqual(['a', 'z.mp3', 'Z.mp3']);
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

describe('entriesToTrackTree 歌词引用', () => {
  it('同目录 stem.lrc 匹配，audio 节点携带 lyrics，text 节点保留', () => {
    const tree = entriesToTrackTree(['a.mp3', 'a.lrc']);
    // 自然序下 'a.lrc' < 'a.mp3'，text 节点排前
    expect(tree[0]).toEqual({ type: 'text', title: 'a.lrc', hash: 'a.lrc' });
    expect(tree[1]).toEqual({
      type: 'audio',
      title: 'a.mp3',
      hash: 'a.mp3',
      lyrics: { hash: 'a.lrc', type: 'lrc' },
    });
  });

  it('优先级：stem.lrc > 原名.lrc > 原名.vtt > stem.vtt', () => {
    // stem.lrc 与 原名.lrc 并存 → 取 stem.lrc
    const t1 = entriesToTrackTree(['x.mp3', 'x.lrc', 'x.mp3.lrc']);
    // 自然序：x.lrc < x.mp3 < x.mp3.lrc，audio 在 [1]
    const n1 = t1[1];
    expect(n1?.type === 'audio' && n1.lyrics?.hash === 'x.lrc').toBe(true);
    // 无 stem.lrc 时回退 原名.lrc
    const t2 = entriesToTrackTree(['x.mp3', 'x.mp3.lrc', 'x.vtt']);
    expect(t2[0]).toEqual({
      type: 'audio',
      title: 'x.mp3',
      hash: 'x.mp3',
      lyrics: { hash: 'x.mp3.lrc', type: 'lrc' },
    });
    // 原名.vtt 优先于 stem.vtt
    const t3 = entriesToTrackTree(['x.mp3', 'x.mp3.vtt', 'x.vtt']);
    const n3 = t3[0];
    expect(n3?.type === 'audio' && n3.lyrics?.hash === 'x.mp3.vtt').toBe(true);
  });

  it('子目录音频匹配同目录歌词，hash 含目录前缀', () => {
    const tree = entriesToTrackTree(['sub/a.wav', 'sub/a.lrc']);
    const sub = tree[0];
    expect(sub?.type === 'folder').toBe(true);
    // children 自然序：a.lrc < a.wav，audio 在 [1]
    const audio = sub?.type === 'folder' ? sub.children[1] : undefined;
    expect(audio).toEqual({
      type: 'audio',
      title: 'a.wav',
      hash: 'sub/a.wav',
      lyrics: { hash: 'sub/a.lrc', type: 'lrc' },
    });
  });

  it('lyrics/ 子目录回退（lrc 优先 vtt）', () => {
    // 子目录 children：文件夹在前 → [folder 'lyrics', audio a.wav]
    const t1 = entriesToTrackTree(['sub/a.wav', 'sub/lyrics/a.lrc']);
    const folder1 = t1[0];
    const n1 = folder1?.type === 'folder' ? folder1.children[1] : undefined;
    expect(n1).toEqual({
      type: 'audio',
      title: 'a.wav',
      hash: 'sub/a.wav',
      lyrics: { hash: 'sub/lyrics/a.lrc', type: 'lrc' },
    });
    const t2 = entriesToTrackTree(['sub/a.wav', 'sub/lyrics/a.vtt']);
    const folder2 = t2[0];
    const n2 = folder2?.type === 'folder' ? folder2.children[1] : undefined;
    expect(n2).toEqual({
      type: 'audio',
      title: 'a.wav',
      hash: 'sub/a.wav',
      lyrics: { hash: 'sub/lyrics/a.vtt', type: 'vtt' },
    });
  });

  it('无候选时 audio 节点不含 lyrics 键', () => {
    const tree = entriesToTrackTree(['a.mp3']);
    expect(tree).toEqual([{ type: 'audio', title: 'a.mp3', hash: 'a.mp3' }]);
  });
});
