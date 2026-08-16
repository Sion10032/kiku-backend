import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { configSchema, sharedConfigSchema, type Config } from './schema.js';

const CONFIG_PATH = process.env.CONFIG_PATH || './data/config.json';

let config: Config;

function generateSecret(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
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

export function getSharedConfig() {
  const cfg = getConfig();
  return sharedConfigSchema.parse(cfg);
}
