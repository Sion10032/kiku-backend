// 阶段执行体契约（phases/* 实现方与 taskSystem 装配方共同依赖的纯类型）。

export type PhaseResult = {
  created?: boolean;
  title?: string;
  detail?: { analyzed?: number; failed?: number };
};

/** scan 分流的物理位置（路径信息随 submit 传入，不入队列身份）。 */
export interface WorkLocation {
  rootFolder: string;
  relativePath: string;
  /** manual 分支标题推导用目录名。 */
  dirName?: string;
  /** manual 分支本地封面导入用绝对路径。 */
  absDir?: string;
}

export interface PhaseContext {
  workId: string;
  /** 仅 metadata 阶段有值：scan 分流的 moved 变体。 */
  variant: 'dlsite' | 'manual' | 'moved' | undefined;
  /** scan 分流的物理位置（metadata 阶段必需）。 */
  location: WorkLocation | undefined;
  signal: AbortSignal;
  log: (level: string, message: string) => void;
  force: boolean;
}

export type PhaseExecutor = (ctx: PhaseContext) => Promise<PhaseResult>;
