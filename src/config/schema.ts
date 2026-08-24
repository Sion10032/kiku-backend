import { z } from 'zod';

export const sharedConfigSchema = z.object({
  instanceMode: z.enum(['private', 'public']).default('private'),
  allowRegistration: z.boolean().default(false),
  pageSize: z.number().default(12),
  tagLanguage: z.enum(['ja-jp', 'zh-tw', 'zh-cn']).default('zh-cn'),
  enableGzip: z.boolean().default(true),
  rewindSeekTime: z.number().default(5),
  forwardSeekTime: z.number().default(30),
  offloadMedia: z.boolean().default(false),
  offloadStreamPath: z.string().default('/media/stream/'),
  offloadDownloadPath: z.string().default('/media/download/'),
});

export const configSchema = sharedConfigSchema.extend({
  production: z.boolean().default(false),
  dbBusyTimeout: z.number().default(1000),
  checkUpdate: z.boolean().default(true),
  checkBetaUpdate: z.boolean().default(false),
  maxParallelism: z.number().min(1).max(64).default(16),
  rootFolders: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
      }),
    )
    .default([]),
  databaseFolderDir: z.string().default('./data/sqlite'),
  md5secret: z.string(),
  jwtsecret: z.string(),
  expiresIn: z.number().default(2592000),
  scannerMaxRecursionDepth: z.number().default(2),
  retry: z.number().default(5),
  dlsiteTimeout: z.number().default(10000),
  hvdbTimeout: z.number().default(10000),
  retryDelay: z.number().default(2000),
  httpProxyHost: z.string().default(''),
  httpProxyPort: z.number().default(0),
  listenPort: z.number().default(8888),
  blockRemoteConnection: z.boolean().default(false),
  behindProxy: z.boolean().default(false),
  httpsEnabled: z.boolean().default(false),
  httpsPrivateKey: z.string().default('kikoeru.key'),
  httpsCert: z.string().default('kikoeru.crt'),
  httpsPort: z.number().default(8443),
  skipCleanup: z.boolean().default(false),
});

export type Config = z.infer<typeof configSchema>;
export type SharedConfig = z.infer<typeof sharedConfigSchema>;
