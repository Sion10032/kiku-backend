// 批次 AbortController 注册表：路由层 fire 时注册，取消端点（kill/stop/DELETE tasks）
// 按批次 abort —— 让编排器自身（prune 等后续阶段）感知取消，而不只是队列里的任务。

const controllers = new Map<string, AbortController>();

export function registerController(
  batchId: string,
  controller: AbortController,
): void {
  controllers.set(batchId, controller);
}

export function unregisterController(batchId: string): void {
  controllers.delete(batchId);
}

/** abort 该批次的编排信号；返回是否命中。须配合 cancelBatch 一起调用（任务 + 编排器两侧取消）。 */
export function abortBatchController(batchId: string): boolean {
  const controller = controllers.get(batchId);
  if (!controller) return false;
  controller.abort();
  return true;
}
