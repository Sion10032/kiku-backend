import type { Config } from './schema.js';

/**
 * 解析服务监听地址（纯函数，import 安全，便于单测）。
 *
 * 优先级：env || config || default——
 * - host：process.env.HOST || (blockRemoteConnection ? '127.0.0.1' : '0.0.0.0')
 * - port：Number(process.env.PORT) || listenPort || 8888
 *
 * 注意：监听地址在 listen 时定死，运行时拨动 blockRemoteConnection /
 * listenPort 开关不会重绑，需重启后端才生效。
 */
export function resolveListenAddress(
  env: Record<string, string | undefined>,
  config: Pick<Config, 'blockRemoteConnection' | 'listenPort'>,
): { host: string; port: number } {
  // env 值经 || 判空：HOST='' / PORT 非数字（NaN）均视为未设置，落到 config
  const host =
    env.HOST || (config.blockRemoteConnection ? '127.0.0.1' : '0.0.0.0');
  const port = Number(env.PORT) || config.listenPort || 8888;
  return { host, port };
}
