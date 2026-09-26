import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Config, configSchema } from './schema.js';

const CONFIG_PATH = process.env.CONFIG_PATH || './data/config.json';

let config: Config;

function generateSecret(): string {
  // 与 kikoeru 一致：64 位 hex、加密安全随机（原 Math.random 拼接非加密安全）
  return randomBytes(32).toString('hex');
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    const defaultConfig: Partial<Config> = {
      md5secret: generateSecret(),
      jwtsecret: generateSecret(),
    };

    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    return configSchema.parse(defaultConfig);
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return configSchema.parse(parsed);
}

export function getConfig(): Config {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

export function updateConfig(updates: Partial<Config>): Config {
  const current = getConfig();
  const merged = { ...current, ...updates };
  config = configSchema.parse(merged);

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

  return config;
}

/** 测试专用：注入配置；省略时清空缓存（下次 getConfig 重新读盘）。 */
export function setConfigForTesting(cfg?: Config): void {
  config = cfg as Config;
}
