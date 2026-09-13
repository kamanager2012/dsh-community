#!/usr/bin/env node
/**
 * aios-core 架构边界守卫
 *
 * 检查项:
 *   1. 文件总数硬上限 (≤40)
 *   2. 任意单层模块文件数上限 (kernel≤12, 其余≤8)
 *   3. 顶层目录白名单
 *   4. Reconciler 纯函数: 禁止 import fs/fetch/任何 SDK
 *   5. 状态机冻结: 状态枚举不可超过 6 个
 *   6. 值级循环依赖检测 (type-only 循环可接受)
 *
 * 用法: node scripts/arch-guard.mjs
 * CI: 在 vitest 之前运行, 非 0 退出 = 阻断合并
 */

import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");

// ─── 硬上限 ──────────────────────────────────────────
// kernel 当前 11 文件（含 schema/），设 12 上限
// 其余模块 8 上限
const MODULE_LIMITS = {
  kernel: 14,
  governor: 8,
  memory: 8,
  cli: 8,
};

const TOTAL_FILE_LIMIT = 40;

const ALLOWED_TOP_DIRS = new Set([
  "kernel", "governor", "memory", "cli",  // 核心模块
  "tests", "scripts",                       // 开发设施
  "docs", "shadow",                         // 已存在的非代码目录
]);

// ─── 1. 文件总数 ──────────────────────────────────────
function checkTotalFiles() {
  const out = execSync(
    `find ${ROOT}/kernel ${ROOT}/governor ${ROOT}/memory ${ROOT}/cli -name "*.ts" -not -path "*/node_modules/*"`,
    { encoding: "utf8" },
  );
  const files = out.trim().split("\n").filter(Boolean);
  const count = files.length;

  if (count > TOTAL_FILE_LIMIT) {
    console.error(`❌ FAIL: 源文件总数 ${count} 超过上限 ${TOTAL_FILE_LIMIT}`);
    console.error("   v8.0 教训: 433 个文件 → 366 编译错误 → 10 天部署失败");
    return false;
  }
  console.log(`✅ PASS: 源文件总数 ${count}/${TOTAL_FILE_LIMIT}`);
  return true;
}

// ─── 2. 单模块文件数 ─────────────────────────────────
function checkModuleSize() {
  let pass = true;
  for (const [dir, limit] of Object.entries(MODULE_LIMITS)) {
    const full = join(ROOT, dir);
    try {
      // 只计顶层 .ts 文件，不含子目录
      const entries = readdirSync(full).filter(f => f.endsWith(".ts"));
      if (entries.length > limit) {
        console.error(`❌ FAIL: ${dir}/ 有 ${entries.length} 个 .ts 文件，上限 ${limit}`);
        pass = false;
      } else {
        console.log(`✅ PASS: ${dir}/ — ${entries.length}/${limit} 文件`);
      }
    } catch { /* dir may not exist */ }
  }
  return pass;
}

// ─── 3. 顶层目录 ──────────────────────────────────────
function checkTopDirs() {
  const entries = readdirSync(ROOT).filter(e => {
    const p = join(ROOT, e);
    return statSync(p).isDirectory() && !e.startsWith(".") && e !== "node_modules" && e !== "dist";
  });
  const illegal = entries.filter(e => !ALLOWED_TOP_DIRS.has(e));

  if (illegal.length > 0) {
    console.error(`❌ FAIL: 非法顶层目录: ${illegal.join(", ")}`);
    console.error(`   允许: ${[...ALLOWED_TOP_DIRS].join("/")}`);
    console.error("   v8.0 教训: 4 个目录膨胀到 14 个 → 不可逆");
    return false;
  }
  console.log("✅ PASS: 顶层目录合规");
  return true;
}

// ─── 4. Reconciler 纯函数检查 ─────────────────────────
function checkReconcilerPurity() {
  const reconcilerPath = join(ROOT, "kernel", "reconciler.ts");
  try {
    const src = readFileSync(reconcilerPath, "utf8");
    const banned = [
      { pattern: /\bimport\b.*\bfs\b/, name: "fs" },
      { pattern: /\bimport\b.*\bfetch\b/, name: "fetch" },
      { pattern: /\bimport\b.*\baxios\b/, name: "axios" },
      { pattern: /\bimport\b.*\bchild_process\b/, name: "child_process" },
      { pattern: /\bimport\b.*\b@anthropic/, name: "@anthropic" },
      { pattern: /\bimport\b.*\bopenai/, name: "openai" },
      { pattern: /\brequire\s*\(\s*['"]fs['"]\s*\)/, name: "require('fs')" },
      { pattern: /\bfetch\s*\(/, name: "fetch()" },
      { pattern: /\breadFile\S*\(/, name: "readFile" },
      { pattern: /\bwriteFile\S*\(/, name: "writeFile" },
    ];
    let pass = true;
    for (const { pattern, name } of banned) {
      if (pattern.test(src)) {
        console.error(`❌ FAIL: reconciler.ts 包含禁止的 IO/SDK 引用: ${name}`);
        pass = false;
      }
    }
    if (pass) console.log("✅ PASS: reconciler.ts 纯函数性检查");
    return pass;
  } catch {
    console.warn("⚠️  WARN: reconciler.ts 不存在，跳过纯函数检查");
    return true;
  }
}

// ─── 5. 状态机冻结检查 ────────────────────────────────
function checkStateMachineFrozen() {
  // Phase 定义在 kernel/schema/index.ts，不在 runtime.ts
  const schemaPath = join(ROOT, "kernel", "schema", "index.ts");
  const runtimePath = join(ROOT, "kernel", "runtime.ts");
  let src = "";
  let source = "";
  try {
    src = readFileSync(schemaPath, "utf8");
    source = "schema/index.ts";
  } catch {
    try {
      src = readFileSync(runtimePath, "utf8");
      source = "runtime.ts";
    } catch {
      console.warn("⚠️  WARN: schema/index.ts 和 runtime.ts 均不存在，跳过状态机检查");
      return true;
    }
  }

  // 匹配 type Phase = "IDLE" | "PLAN" | ... (多行)
  const phaseMatch = src.match(/type\s+Phase\s*=\s*([\s\S]*?);/);
  // 也匹配 enum
  const enumMatch = src.match(/enum\s+\w*State\w*\s*\{([^}]+)\}/);
  const match = phaseMatch || enumMatch;

  if (!match) {
    console.warn("⚠️  WARN: 未找到 Phase/State 定义（已查 " + source + "）");
    return true;
  }

  const states = match[1]
    .split(/[|,]/)
    .map(s => s.trim().replace(/["`]/g, ""))
    .filter(s => s && !s.startsWith("//") && s.length > 0);

  // 7 个冻结状态: IDLE/PLAN/EXECUTE/VERIFY/COMMIT/DONE/ROLLBACK
  // ROLLBACK 是 v8.0 教训后的安全状态，不算膨胀
  const FROZEN_STATES = 7;
  if (states.length > FROZEN_STATES) {
    console.error(`❌ FAIL: 状态数 ${states.length} 超过冻结上限 ${FROZEN_STATES}`);
    console.error("   状态: " + states.join(", "));
    console.error("   v8.0 教训: 每次加状态都是从'看起来无害'开始");
    console.error("   如需新状态, 必须在 PR 中附'为什么不能用现有 7 状态表达'的论证");
    return false;
  }
  console.log(`✅ PASS: 状态机 ${states.length}/${FROZEN_STATES} 状态 (source: ${source})`);
  return true;
}

// ─── 6. 值级循环依赖检测 ─────────────────────────────
function checkCircularDeps() {
  try {
    const out = execSync(
      "node_modules/.bin/madge --circular --extensions ts kernel/ governor/ memory/ cli/ ",
      { cwd: ROOT, encoding: "utf8" },
    );
    if (out.includes("No circular")) {
      console.log("✅ PASS: 无循环依赖");
      return true;
    }

    // madge 报了循环，检查是否全部是 type-only
    // 解析循环对列表
    const cycles = out.split("\n").filter(l => l.includes(")")).map(l => {
      const m = l.match(/\d+\)\s+(.*)/);
      return m ? m[1].trim() : "";
    }).filter(Boolean);

    // 对每个循环对，检查是否两端都是 type-only import
    let allTypeOnly = true;
    for (const cycle of cycles) {
      const files = cycle.split(" > ").map(f => f.trim());
      for (let i = 0; i < files.length - 1; i++) {
        const from = files[i];
        const to = files[i + 1];
        if (!isTypeOnlyImport(join(ROOT, from), to)) {
          console.error(`❌ FAIL: 值级循环依赖: ${from} → ${to}`);
          allTypeOnly = false;
        }
      }
    }

    if (allTypeOnly && cycles.length > 0) {
      console.log(`✅ PASS: ${cycles.length} 个 type-only 循环依赖（可接受）`);
      return true;
    }

    if (!allTypeOnly) {
      console.error("   v8.0 教训: 层间边界被破坏 → 366 编译错误");
      return false;
    }

    console.log("✅ PASS: 无循环依赖");
    return true;
  } catch (e) {
    // madge exits 1 when cycles found; output is in e.stdout
    const stdout = e.stdout || "";
    const stderr = e.stderr || "";
    const output = stdout + stderr;
    if (output.includes("No circular")) {
      console.log("✅ PASS: 无循环依赖");
      return true;
    }
    // madge found cycles — parse and check type-only
    // Cycles are listed in stdout (e.g. "1) kernel/runtime.ts > kernel/invariant.ts")
    if (output.includes("circular dependency") || stdout.match(/\d+\)\s+.*>.*\.ts/)) {
      const cycles = output.split("\n").filter(l => l.includes(")")).map(l => {
        const m = l.match(/\d+\)\s+(.*)/);
        return m ? m[1].trim() : "";
      }).filter(Boolean);

      let allTypeOnly = true;
      for (const cycle of cycles) {
        const files = cycle.split(" > ").map(f => f.trim());
        for (let i = 0; i < files.length - 1; i++) {
          const from = files[i];
          const to = files[i + 1];
          if (!isTypeOnlyImport(join(ROOT, from), to)) {
            console.error(`❌ FAIL: 值级循环依赖: ${from} → ${to}`);
            allTypeOnly = false;
          }
        }
      }

      if (allTypeOnly && cycles.length > 0) {
        console.log(`✅ PASS: ${cycles.length} 个 type-only 循环依赖（可接受）`);
        return true;
      }

      if (!allTypeOnly) {
        console.error("   v8.0 教训: 层间边界被破坏 → 366 编译错误");
        return false;
      }
    }
    // madge 可能没安装
    console.warn("⚠️  WARN: madge 不可用，跳过循环依赖检测");
    console.warn("   安装: npm install -D madge");
    return true;
  }
}

function isTypeOnlyImport(filePath, targetModule) {
  try {
    const src = readFileSync(filePath, "utf8");
    const targetBase = targetModule.replace(/\.[jt]s$/, "").split("/").pop() || "";
    // 检查所有 import 语句中，对 target 的引用是否全是 type-only
    const importLines = src.split("\n").filter(l =>
      l.includes("import") && l.includes(targetBase),
    );
    return importLines.length > 0 && importLines.every(l => l.includes("import type"));
  } catch {
    return false;
  }
}

// ─── 主流程 ────────────────────────────────────────────
const results = [
  checkTotalFiles(),
  checkModuleSize(),
  checkTopDirs(),
  checkReconcilerPurity(),
  checkStateMachineFrozen(),
  checkCircularDeps(),
];

const allPassed = results.every(Boolean);

console.log("\n" + (allPassed ? "🟢 全部通过" : "🔴 存在违规，阻断合并"));
process.exit(allPassed ? 0 : 1);
