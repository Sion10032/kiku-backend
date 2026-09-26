import { z } from 'zod';

export const configSchema = z.object({
  instanceMode: z.enum(['private', 'public']).default('private'),
  allowRegistration: z.boolean().default(false),
  tagLanguage: z.enum(['ja-jp', 'zh-tw', 'zh-cn']).default('zh-cn'),
  autoLoudnessAnalysis: z.boolean().default(false),
  production: z.boolean().default(false),
  dbBusyTimeout: z.number().default(1000),
  checkUpdate: z.boolean().default(true),
  checkBetaUpdate: z.boolean().default(false),
  maxParallelism: z.number().min(1).max(64).default(16),
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
  /** kikoeru 旧数据迁移完成时刻（ISO 8601）；存在即不再迁移。 */
  kikoeruMigratedAt: z.string().optional(),
  /** 迁移后向导管理员创建已消费 */
  kikoeruSetupConsumed: z.boolean().optional(),
  ffmpegPath: z.string().default('ffmpeg'),
  analysisParallelism: z.number().min(1).max(8).default(2),
});

export type Config = z.infer<typeof configSchema>;
