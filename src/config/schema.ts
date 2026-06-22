import { z } from 'zod';

export const configSchema = z.object({
  production: z.boolean().default(false),
  dbBusyTimeout: z.number().default(1000),
  checkUpdate: z.boolean().default(true),
  checkBetaUpdate: z.boolean().default(false),
  maxParallelism: z.number().min(1).max(64).default(16),
  rootFolders: z.array(z.object({
    name: z.string(),
    path: z.string(),
  })).default([]),
  coverFolderDir: z.string().default('./covers'),
  databaseFolderDir: z.string().default('./sqlite'),
  auth: z.boolean().default(true),
  md5secret: z.string(),
  jwtsecret: z.string(),
  expiresIn: z.number().default(2592000),
  scannerMaxRecursionDepth: z.number().default(2),
  pageSize: z.number().default(12),
  tagLanguage: z.enum([ 'ja-jp', 'zh-tw', 'zh-cn' ]).default('zh-cn'),
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
  enableGzip: z.boolean().default(true),
  rewindSeekTime: z.number().default(5),
  forwardSeekTime: z.number().default(30),
  offloadMedia: z.boolean().default(false),
  offloadStreamPath: z.string().default('/media/stream/'),
  offloadDownloadPath: z.string().default('/media/download/'),
});

export const loginSchema = z.object({
  name: z.string().min(4),
  password: z.string().min(5),
});

export const createUserSchema = z.object({
  name: z.string().min(5),
  password: z.string().min(5),
  group: z.enum([ 'user', 'guest' ]),
});

export const updatePasswordSchema = z.object({
  name: z.string().min(5),
  newPassword: z.string().min(5),
});

export const deleteUsersSchema = z.object({
  users: z.array(z.object({ name: z.string() })),
});

export const reviewSchema = z.object({
  work_id: z.number(),
  rating: z.number().min(1).max(5).optional(),
  review_text: z.string().optional(),
  progress: z.enum([ 'marked', 'listening', 'listened', 'replay', 'postponed' ]).optional(),
  starOnly: z.boolean().optional(),
  progressOnly: z.boolean().optional(),
});

export const worksQuerySchema = z.object({
  page: z.coerce.number().default(1),
  order: z.enum([ 'id', 'release', 'random', 'betterRandom' ]).default('release'),
  sort: z.enum([ 'asc', 'desc' ]).default('desc'),
  seed: z.coerce.number().optional(),
});

export type Config = z.infer<typeof configSchema>;
