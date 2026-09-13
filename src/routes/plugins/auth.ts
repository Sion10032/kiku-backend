import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { getConfig } from '../../infra/config/index.js';
import { getUserByName } from '../../services/user.service.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { name: string; group: string; ver: number };
    user: { name: string; group: string; ver: number };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    authenticateAdmin: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

export interface JwtPayload {
  name: string;
  group: string;
  /** 吊销声明：签发时的用户 token 版本号（改密 +1） */
  ver: number;
}

/** 私有模式下匿名可访问的白名单路径 */
const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/health',
  '/api/config/shared',
  '/api/setup',
];

/** token 提取：Authorization header → URL 查询参数 token（媒体资源等无法带 header 的场景） */
function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  const query = request.query as Record<string, unknown> | undefined;
  const token = query?.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

async function plugin(fastify: FastifyInstance) {
  const config = getConfig();

  await fastify.register(fastifyJwt, {
    secret: config.jwtsecret,
    sign: {
      expiresIn: config.expiresIn,
    },
  });

  // 共享校验：verify 验签 + 回查用户表，三条鉴权路径（私有模式钩子 /
  // authenticate / authenticateAdmin）统一走这里，避免逻辑分叉。
  // 1. 存在性：被删用户 / 幽灵 token 一律 401（顺带修掉写 review 等触发
  //    users 外键约束的 500）；
  // 2. ver 比对：与当前行 token 版本不一致即已改密 → 401；
  // 3. group 以库为准：降级 / 提权即时生效，不信任 token 声明。
  const verifyAndLoadUser = async (
    token: string,
  ): Promise<{ name: string; group: string; ver: number }> => {
    let decoded: { name: string; group: string; ver: number };
    try {
      decoded = fastify.jwt.verify(token);
    } catch {
      throw fastify.httpErrors.unauthorized();
    }
    const user = await getUserByName(decoded.name);
    if (!user) throw fastify.httpErrors.unauthorized();
    if (decoded.ver !== user.tokenVersion) {
      throw fastify.httpErrors.unauthorized();
    }
    return { name: decoded.name, group: user.group, ver: decoded.ver };
  };

  // 私有模式全局守卫：白名单外的所有请求必须携带有效 JWT
  // 每次执行读 getConfig()，运行时切换模式立即生效
  fastify.addHook('onRequest', async (request) => {
    if (getConfig().instanceMode !== 'private') return;

    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`)))
      return;

    const token = extractToken(request);
    if (!token) throw fastify.httpErrors.unauthorized();
    request.user = await verifyAndLoadUser(token);
  });

  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const token = extractToken(request);
      if (!token) throw fastify.httpErrors.unauthorized();
      request.user = await verifyAndLoadUser(token);
    },
  );

  fastify.decorate(
    'authenticateAdmin',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const token = extractToken(request);
      if (!token) throw fastify.httpErrors.unauthorized();
      // 回查/ver 失败 → 401；通过但库内非管理员 → 403。
      // 必须赋 request.user：public 模式无全局钩子，下游路由依赖它取调用方
      const user = await verifyAndLoadUser(token);
      request.user = user;
      if (user.group !== 'administrator') {
        throw fastify.httpErrors.forbidden();
      }
    },
  );
}

export const authPlugin = fp(plugin, { name: 'auth' });
