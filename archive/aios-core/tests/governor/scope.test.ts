import { describe, it, expect } from "vitest";
import { ScopeValidator, DEFAULT_POLICY } from "../../governor/scope.js";

describe("ScopeValidator", () => {
  it("allows files under allowed paths", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath("src/foo.ts")).toBe(true);
    expect(sv.validatePath("lib/bar.js")).toBe(true);
  });

  it("denies files under denied paths", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath("/etc/passwd")).toBe(false);
    expect(sv.validatePath(".env")).toBe(false);
    expect(sv.validatePath("secrets/key.pem")).toBe(false);
    expect(sv.validatePath("/usr/bin/bash")).toBe(false);
  });

  it("denies traversal, absolute paths, and denied-path case variants", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath("../../etc/passwd")).toBe(false);
    expect(sv.validatePath("../outside.txt")).toBe(false);
    expect(sv.validatePath("/tmp/absolute.txt")).toBe(false);
    expect(sv.validatePath("config/.ENV")).toBe(false);
  });

  it("fails closed on Windows, UNC, home, empty and NUL-containing paths", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath("C:\\Windows\\System32\\drivers\\etc\\hosts")).toBe(false);
    expect(sv.validatePath("C:/Windows/System32/drivers/etc/hosts")).toBe(false);
    expect(sv.validatePath("C:relative\\escape.txt")).toBe(false);
    expect(sv.validatePath("\\\\server\\share\\payload.txt")).toBe(false);
    expect(sv.validatePath("//server/share/payload.txt")).toBe(false);
    expect(sv.validatePath("~/outside.txt")).toBe(false);
    expect(sv.validatePath("~")).toBe(false);
    expect(sv.validatePath("")).toBe(false);
    expect(sv.validatePath("   ")).toBe(false);
    expect(sv.validatePath(".")).toBe(false);
    expect(sv.validatePath("src/\0payload.ts")).toBe(false);
  });

  it("denies denied file types case-insensitively", () => {
    const sv = new ScopeValidator();
    expect(sv.validateFileType("cert.pem")).toBe(false);
    expect(sv.validateFileType("server.key")).toBe(false);
    expect(sv.validateFileType("CERT.PEM")).toBe(false);
    expect(sv.validateFileType("src/app.ts")).toBe(true);
  });

  it("validates plan — all files must pass", () => {
    const sv = new ScopeValidator();
    const goodPlan = { files: ["src/a.ts", "src/b.ts"], scope: ["src/**"], risk: "low" as const, task: "t", steps: [], tests: [], rollback: "", approval: "AUTO" as const, createdAt: "", frozen: false };
    expect(sv.validatePlan(goodPlan as any)).toBe(true);

    const badPlan = { files: ["src/a.ts", "/etc/passwd"], scope: ["src/**"], risk: "low" as const, task: "t", steps: [], tests: [], rollback: "", approval: "AUTO" as const, createdAt: "", frozen: false };
    expect(sv.validatePlan(badPlan as any)).toBe(false);
  });

  it("allows commands in allowed list", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("git status")).toBe(true);
    expect(sv.validateCommand("node build.js")).toBe(true);
  });

  it("denies dangerous commands", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("rm -rf /")).toBe(false);
    expect(sv.validateCommand("sudo apt install")).toBe(false);
  });

  it("denies measured inline-execution and destructive-Git false allows", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("python3 -c \"print('x')\"")).toBe(false);
    expect(sv.validateCommand("git reset --hard HEAD")).toBe(false);
    expect(sv.validateCommand("git reset --hard origin/main")).toBe(false);
    expect(sv.validateCommand("git clean -fdx")).toBe(false);
    expect(sv.validateCommand("git clean -fd")).toBe(false);
    expect(sv.validateCommand("git clean -f")).toBe(false);
    expect(sv.validateCommand("git push --force origin main")).toBe(false);
    expect(sv.validateCommand("git push -f origin main")).toBe(false);
    expect(sv.validateCommand("git checkout -- .")).toBe(false);
    expect(sv.validateCommand("git restore -- .")).toBe(false);
    expect(sv.validateCommand("X=reset; Y=--hard; git $X $Y HEAD")).toBe(false);
  });

  it("keeps bounded multi-token deny rules from matching safer sibling commands", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("git push --force-with-lease origin main")).toBe(true);
    expect(sv.validateCommand("git restore --staged -- .")).toBe(true);
    expect(sv.validateCommand("git rebase --abort")).toBe(true);
    expect(sv.validateCommand("git stash drop")).toBe(true);
    expect(sv.validateCommand("git branch -D feature-branch")).toBe(true);
  });

  it("rejects command chaining with dangerous second command", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("git status; rm -rf /")).toBe(false);
    expect(sv.validateCommand("git status && sudo reboot")).toBe(false);
    expect(sv.validateCommand("echo hi | rm -rf /")).toBe(false);
    expect(sv.validateCommand("git status\nrm -rf /")).toBe(false);
  });

  it("rejects live command substitutions but not quoted dangerous-looking literals", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("echo $(rm -rf /)")).toBe(false);
    expect(sv.validateCommand("echo `rm -rf /`")).toBe(false);
    expect(sv.validateCommand('echo "rm -rf /"')).toBe(true);
    expect(sv.validateCommand("echo 'sudo reboot'")).toBe(true);
    expect(sv.validateCommand('echo "$(rm -rf /)"')).toBe(false);
  });

  it("resolves simple variable-indirection bypasses before validation", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("X=rm; $X -rf /")).toBe(false);
    expect(sv.validateCommand("X=rm; ${X} -rf /")).toBe(false);
    expect(sv.validateCommand("A=rm; B=$A; $B -rf /")).toBe(false);
    expect(sv.validateCommand("FOO=bar git status")).toBe(true);
    expect(sv.validateCommand("X=echo; $X hi")).toBe(true);
  });

  it("allows safe chained commands", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("git status && git log")).toBe(true);
    expect(sv.validateCommand("tsc && vitest")).toBe(true);
  });

  it("flags mass-deletion semantics separately from the ordinary allow-list", () => {
    const sv = new ScopeValidator();
    expect(sv.isMassDelete("find . -delete")).toBe(true);
    expect(sv.isMassDelete("find . -exec rm {} +")).toBe(true);
    expect(sv.isMassDelete("rm -rf build/*")).toBe(true);
    expect(sv.isMassDelete("git status")).toBe(false);
    expect(sv.isMassDelete('echo "find . -delete"')).toBe(false);
  });

  it("applies project path policy to shell write targets", () => {
    const sv = new ScopeValidator();
    expect(sv.commandTargetsDeniedPath("echo x > /etc/passwd")).toBe(true);
    expect(sv.commandTargetsDeniedPath("echo x > ../../outside.txt")).toBe(true);
    expect(sv.commandTargetsDeniedPath("echo x > ~/.ssh/authorized_keys")).toBe(true);
    expect(sv.commandTargetsDeniedPath("echo x > C:\\Windows\\Temp\\out.txt")).toBe(true);
    expect(sv.commandTargetsDeniedPath("echo x > //server/share/out.txt")).toBe(true);
    expect(sv.commandTargetsDeniedPath("echo x > .env")).toBe(true);
    expect(sv.commandTargetsDeniedPath("echo x > logs/out.txt")).toBe(false);
    expect(sv.commandTargetsDeniedPath("cp template.txt dist/out.txt")).toBe(false);
  });

  it("surfaces elevated general-purpose executors without changing default decisions", () => {
    const sv = new ScopeValidator({
      policy: { ...DEFAULT_POLICY, elevatedCommands: ["node", "npm"] },
    });
    expect(sv.validateCommand("node build.js")).toBe(true);
    expect(sv.usesElevatedCommand("node build.js")).toBe(true);
    expect(sv.usesElevatedCommand("git status")).toBe(false);
  });

  it("supports custom policies", () => {
    const sv = new ScopeValidator({
      policy: {
        allowedPaths: ["src/**"],
        deniedPaths: ["src/secret/**"],
        allowedCommands: ["node"],
        deniedCommands: [],
        deniedFileTypes: [],
      },
    });
    expect(sv.validatePath("src/app.ts")).toBe(true);
    expect(sv.validatePath("src/secret/vault.ts")).toBe(false);
    expect(sv.validatePath("lib/out.ts")).toBe(false);
    expect(sv.validateCommand("git")).toBe(false);
    expect(sv.validateCommand("node")).toBe(true);
  });

  it("keeps legacy ACS scope opt-in instead of canonical default", () => {
    const acs = {
      isLocked: () => false,
      getScope: () => ["src/"],
    };
    const sv = new ScopeValidator({ acs });
    const plan = { files: ["src/a.ts"], scope: ["src/**"], risk: "low" as const, task: "t", steps: [], tests: [], rollback: "", approval: "AUTO" as const, createdAt: "", frozen: false };
    expect(sv.validatePlanWithAcs(plan as any)).toEqual({ ok: true });
  });
});
