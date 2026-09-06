import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { getConfig } from '../../infra/config/index.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { name: string; group: string };
    user: { name: string; group: string };
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

  // 私有模式全局守卫：白名单外的所有请求必须携带有效 JWT
  // 每次执行读 getConfig()，运行时切换模式立即生效
  fastify.addHook('onRequest', async (request) => {
    if (getConfig().instanceMode !== 'private') return;

    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`)))
      return;

    const token = extractToken(request);
    if (!token) throw fastify.httpErrors.unauthorized();

    try {
      request.user = fastify.jwt.verify(token);
    } catch {
      throw fastify.httpErrors.unauthorized();
    }
  });

  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        throw fastify.httpErrors.unauthorized();
      }
    },
  );

  fastify.decorate(
    'authenticateAdmin',
    async (request: FastifyRequest, _reply: FastifyReply) => {
      try {
        const decoded = await request.jwtVerify<JwtPayload>();
        if (decoded.group !== 'administrator') {
          throw fastify.httpErrors.forbidden();
        }
      } catch {
        throw fastify.httpErrors.unauthorized();
      }
    },
  );
}

export const authPlugin = fp(plugin, { name: 'auth' });
