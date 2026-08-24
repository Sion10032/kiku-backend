import { expect } from 'bun:test';

/**
 * 断言值非空（排除 null 与 undefined）并窄化类型，
 * 用于替代 `!` 非空断言（对应 Biome noNonNullAssertion 规则）。
 *
 * 用法：
 * ```ts
 * const got = getBlob(ns, 'a');
 * expectNotNull(got);
 * got.data; // 类型已窄化为非空
 * ```
 */
export function expectNotNull<T>(value: T): asserts value is NonNullable<T> {
  expect(value).not.toBeNull();
  expect(value).toBeDefined();
}
