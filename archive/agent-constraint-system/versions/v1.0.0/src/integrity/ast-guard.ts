/**
 * ACS AST Guard
 * =============
 * AST 级完整性校验：public API、import、type、function 签名。
 * 比简单的 export 计数更深入，防止 agent 表面保留 export 但掏空实现。
 */

const RETURN_TYPE_CONTEXT_WINDOW = 200;

export interface ASTSnapshot {
  exports: string[];
  imports: string[];
  functionSignatures: FunctionSig[];
  interfaceNames: string[];
  typeAliases: string[];
  classNames: string[];
  constExports: string[];
}

export interface FunctionSig {
  name: string;
  exported: boolean;
  async: boolean;
  params: string;
  returnVoid: boolean;
}

export interface ASTDiff {
  removedExports: string[];
  removedImports: string[];
  removedInterfaces: string[];
  removedTypes: string[];
  removedClasses: string[];
  removedFunctions: string[];
  hollowedExports: string[];
}

const EXPORT_RE = /^export\s+(interface|type|class|function|const|enum|let|var|default\s+function)\s+(\w+)/gm;
const IMPORT_RE = /^import\s+(?:\{[^}]+\}|[^;]+)\s+from\s+['"].+?['"]/gm;
const IMPORT_SPEC_RE = /import\s+\{([^}]+)\}\s+from/g;
const FUNC_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
const IFACE_RE = /^(?:export\s+)?interface\s+(\w+)/gm;
const TYPE_RE = /^(?:export\s+)?type\s+(\w+)/gm;
const CLASS_RE = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm;
const CONST_EXPORT_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm;

export class ASTGuard {
  snapshot(content: string): ASTSnapshot {
    const exports: string[] = [];
    for (const m of content.matchAll(EXPORT_RE)) {
      exports.push(m[2]);
    }

    const imports: string[] = [];
    for (const m of content.matchAll(IMPORT_SPEC_RE)) {
      const names = m[1].split(",").map((n) => n.trim());
      imports.push(...names);
    }

    const functionSignatures: FunctionSig[] = [];
    for (const m of content.matchAll(FUNC_RE)) {
      const ctxStart = m.index || 0;
      const ctxEnd = ctxStart + RETURN_TYPE_CONTEXT_WINDOW;
      functionSignatures.push({
        name: m[1],
        exported: m[0].startsWith("export"),
        async: m[0].includes("async"),
        params: m[2].trim(),
        returnVoid: content.slice(ctxStart, ctxEnd).includes(": void") ||
                   content.slice(ctxStart, ctxEnd).includes(": Promise<void>"),
      });
    }

    const interfaceNames: string[] = [];
    for (const m of content.matchAll(IFACE_RE)) {
      interfaceNames.push(m[1]);
    }

    const typeAliases: string[] = [];
    for (const m of content.matchAll(TYPE_RE)) {
      typeAliases.push(m[1]);
    }

    const classNames: string[] = [];
    for (const m of content.matchAll(CLASS_RE)) {
      classNames.push(m[1]);
    }

    const constExports: string[] = [];
    for (const m of content.matchAll(CONST_EXPORT_RE)) {
      constExports.push(m[1]);
    }

    return { exports, imports, functionSignatures, interfaceNames, typeAliases, classNames, constExports };
  }

  diff(before: ASTSnapshot, after: ASTSnapshot): ASTDiff {
    return {
      removedExports: before.exports.filter((e) => !after.exports.includes(e)),
      removedImports: before.imports.filter((i) => !after.imports.includes(i)),
      removedInterfaces: before.interfaceNames.filter((n) => !after.interfaceNames.includes(n)),
      removedTypes: before.typeAliases.filter((t) => !after.typeAliases.includes(t)),
      removedClasses: before.classNames.filter((c) => !after.classNames.includes(c)),
      removedFunctions: before.functionSignatures
        .filter((f) => !after.functionSignatures.some((af) => af.name === f.name))
        .map((f) => f.name),
      hollowedExports: before.functionSignatures
        .filter((f) => {
          const match = after.functionSignatures.find((af) => af.name === f.name);
          return match && match.params !== f.params;
        })
        .map((f) => `${f.name}(${f.params}) → params changed`),
    };
  }
}