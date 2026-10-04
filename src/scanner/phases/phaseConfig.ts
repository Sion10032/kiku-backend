// 阶段注册表：资源池归属、容错分级、依赖边与任务 key 编解码。
// analyze 不设队列级 dep：track 属 warn-continue，失败不得阻断分析接力
//（先后顺序由编排器 barrier 时序保证，见 spec 行为对齐表）。

import type { Phase } from '../taskEvents.js';

export const PHASE_ORDER: readonly Phase[] = [
  'metadata',
  'cover',
  'track',
  'analyze',
] as const;

export interface PhaseConfig {
  resource: 'net' | 'cpu';
  failurePolicy: 'fail-pipeline' | 'warn-continue';
  deps: Phase[];
}

export const PHASE_CONFIG: Record<Phase, PhaseConfig> = {
  metadata: { resource: 'net', failurePolicy: 'fail-pipeline', deps: [] },
  cover: {
    resource: 'net',
    failurePolicy: 'warn-continue',
    deps: ['metadata'],
  },
  track: {
    resource: 'net',
    failurePolicy: 'warn-continue',
    deps: ['metadata'],
  },
  analyze: { resource: 'cpu', failurePolicy: 'fail-pipeline', deps: [] },
};

export const PRIORITY_VALUE = { low: 0, high: 10 } as const;

export function taskKey(phase: Phase, workId: string): string {
  return `${phase}:${workId}`;
}

export function parseTaskKey(key: string): { phase?: Phase; workId: string } {
  const i = key.indexOf(':');
  if (i < 0) return { workId: key };
  const phase = key.slice(0, i);
  if (!(PHASE_ORDER as readonly string[]).includes(phase))
    return { workId: key };
  return { phase: phase as Phase, workId: key.slice(i + 1) };
}
