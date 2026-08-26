import { setupTestEnvironment } from './setup';

// bunfig.toml [test] preload：在任何测试模块（含 src/db、src/config）加载前
// 设置 CONFIG_PATH 指向隔离的临时测试库。ESM 静态 import 会被提升，
// 测试文件内的 setupTestEnvironment() 调用发生在 db 模块加载之后，
// 无法阻止其连上 ./data/sqlite 真实库——必须在 preload 阶段完成。
setupTestEnvironment();
