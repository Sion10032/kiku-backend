import { describe, expect, it } from 'bun:test';
import { resolveListenAddress } from '../src/infra/config/listen-address';
import { configSchema } from '../src/infra/config/schema';

function makeConfig(
  overrides: Partial<{ blockRemoteConnection: boolean; listenPort: number }>,
) {
  return configSchema.parse({ md5secret: 'a', jwtsecret: 'b', ...overrides });
}

describe('resolveListenAddress', () => {
  it('env HOST/PORT 显式设置时优先于 config', () => {
    const addr = resolveListenAddress(
      { HOST: '192.168.1.10', PORT: '7777' },
      makeConfig({ blockRemoteConnection: true, listenPort: 9999 }),
    );
    expect(addr).toEqual({ host: '192.168.1.10', port: 7777 });
  });

  it('blockRemoteConnection=true 且无 env 时绑 127.0.0.1', () => {
    const addr = resolveListenAddress(
      {},
      makeConfig({ blockRemoteConnection: true }),
    );
    expect(addr).toEqual({ host: '127.0.0.1', port: 8888 });
  });

  it('blockRemoteConnection=false 且无 env 时绑 0.0.0.0（现状默认，向后兼容）', () => {
    const addr = resolveListenAddress(
      {},
      makeConfig({ blockRemoteConnection: false }),
    );
    expect(addr).toEqual({ host: '0.0.0.0', port: 8888 });
  });

  it('无 env 且 config.listenPort=9999 时监听 9999', () => {
    const addr = resolveListenAddress({}, makeConfig({ listenPort: 9999 }));
    expect(addr).toEqual({ host: '0.0.0.0', port: 9999 });
  });
});
