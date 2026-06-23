import { mkdirSync, existsSync, writeFileSync } from 'fs';

export function setupTestEnvironment(): void {
  // Create necessary directories
  if (!existsSync('./sqlite')) {
    mkdirSync('./sqlite', { recursive: true });
  }

  // Create a default config file for testing
  if (!existsSync('./config.json')) {
    const defaultConfig = {
      md5secret: 'test-md5-secret',
      jwtsecret: 'test-jwt-secret',
    };
    writeFileSync('./config.json', JSON.stringify(defaultConfig, null, 2), 'utf-8');
  }
}
