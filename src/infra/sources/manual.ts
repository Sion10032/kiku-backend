/**
 * 人工作品（非 DLsite）的前缀常量与标题推导。
 *
 * 命名规则：`{前缀}{6或8位数字}_{标题}`，例：`UW00000001_测试作品`。
 * 新增人工前缀时直接在下方 MANUAL_PREFIXES 数组追加（代码常量，不走配置）。
 * 注意：与前端 `kiku-frontend/src/utils/workId.ts` 的 MANUAL_PREFIXES 人工对齐，
 * 两侧修改需同步。
 */

/** 人工作品代码前缀集合（代码常量，非配置）。 */
export const MANUAL_PREFIXES: readonly string[] = ['UW'];

/**
 * 从文件夹名推导人工作品标题：去掉作品代码后的剩余部分，剥掉开头的分隔符
 * （下划线 / 空白 / 连字符）；若剩余为空则回退为整个文件夹名。
 */
export function deriveManualTitle(folderName: string, code: string): string {
  // 前缀大小写不敏感（如 uw00000001-foo 也能命中 UW00000001），长度一致可直接按长度截取。
  const upper = folderName.toUpperCase();
  const codeUpper = code.toUpperCase();
  const rest = upper.startsWith(codeUpper)
    ? folderName.slice(codeUpper.length)
    : '';
  const title = rest.replace(/^[_\s-]+/, '');
  return title || folderName;
}
