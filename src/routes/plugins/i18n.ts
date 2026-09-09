import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { en as zodEn, zhCN as zodZhCN } from 'zod/locales';
import { type Locale, negotiate, translate } from '../../infra/i18n/index.js';

/** 支持语言对应的 zod 内置 locale（issue 消息在 safeParse 时生成）。 */
const ZOD_LOCALES = { 'zh-CN': zodZhCN, en: zodEn } as const;

declare module 'fastify' {
  interface FastifyRequest {
    /** 本请求按 Accept-Language 协商出的语言。 */
    language: Locale;
  }
  interface FastifyReply {
    /** 返回统一 { error: <本地化消息> } 错误体，消息来自 infra/i18n 字典。 */
    fail(
      statusCode: number,
      errorKey: string,
      params?: Record<string, string | number>,
    ): void;
  }
}

async function plugin(fastify: FastifyInstance) {
  // preValidation 是校验前最后一个钩子：此处同步切换 zod 全局 locale 后，
  // 与校验（同步 safeParse）之间仅剩微任务级窗口，并发下实际不可及。
  // 不能放 onRequest——与校验之间隔着 body 解析的 await，并发请求会互相切走 locale。
  fastify.addHook('preValidation', (request, _reply, done) => {
    const raw = request.headers['accept-language'];
    const header = Array.isArray(raw) ? raw.join(',') : raw;
    request.language = negotiate(header);
    z.config(ZOD_LOCALES[request.language]());
    done();
  });

  fastify.decorateReply(
    'fail',
    function (
      this: FastifyReply,
      statusCode: number,
      errorKey: string,
      params?: Record<string, string | number>,
    ) {
      this.status(statusCode).send({
        error: translate(this.request.language, errorKey, params),
      });
    },
  );

  fastify.setErrorHandler((error, _request, reply) => {
    if (!hasZodFastifySchemaValidationErrors(error)) {
      // 非校验错误维持 Fastify 默认序列化（{ statusCode, error, message }），不改变现状。
      return reply.send(error);
    }
    // issue 消息已被 z.config 按请求本地化；合并为一条，统一走 { error } 格式。
    const detail = error.validation
      .map((v) => {
        const path = v.instancePath
          ? `${v.instancePath.replace(/^\//, '')}: `
          : '';
        return `${path}${v.message ?? ''}`.trim();
      })
      .filter(Boolean)
      .join('; ');
    return reply.fail(400, 'errors.validation', {
      detail: detail ? ` (${detail})` : '',
    });
  });
}

export const i18nPlugin = fastifyPlugin(plugin, { name: 'i18n' });
