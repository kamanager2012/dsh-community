/**
 * ACS Runtime Constants
 * =====================
 * 共享的路径常量，确保所有模块写入相同的 runtime 目录。
 * 
 * 计算方式：constants.ts 位于 src/runtime/constants.ts
 * 从文件位置向上 3 层到达项目根目录：
 *   constants.ts → src/runtime/ → src/ → project root
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src/runtime/constants.ts → 3 levels up = project root
const PROJECT_ROOT = join(__dirname, "..", "..", "..");

export const RUNTIME_DIR = join(PROJECT_ROOT, ".claude", "runtime");
export const SNAPSHOT_DIR = join(RUNTIME_DIR, "snapshots");
export const BACKUP_DIR = join(RUNTIME_DIR, "rollback-cache");
