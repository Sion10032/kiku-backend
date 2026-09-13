import { buildApp } from './app.js';
import { getConfig } from './infra/config/index.js';
import { resolveListenAddress } from './infra/config/listen-address.js';

const app = await buildApp();

const { host, port } = resolveListenAddress(process.env, getConfig());

try {
  await app.listen({ port, host });
  console.log(`Server is running on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
