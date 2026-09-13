# ACS v1.4.0 模式一览与切换方式

## 1. 运行模式 (MODE.json)

由 `MODE_FILE = RUNTIME_DIR / "MODE.json"` 控制。

| 模式 | 效果 |
|------|------|
| ACTIVE / RESEARCH | 研发模式 — inline/heredoc interpreter 只警告不拦截 |
| 其他 / UNKNOWN (默认) | 严格模式 — 所有匹配的危险命令全部拦截 |

```bash
# 研发模式
echo '{"mode": "ACTIVE"}' > ~/.claude/runtime/MODE.json

# 严格模式
echo '{"mode": "STRICT"}' > ~/.claude/runtime/MODE.json

# 查看
cat ~/.claude/runtime/MODE.json
```

## 2. Proposal 模式

`init` 时通过 `--proposal` 参数开启。

| 模式 | 效果 |
|------|------|
| proposal=False (默认) | scope 外写入直接 DENY |
| proposal=True | scope 外写入需 /proposal 审批 |

```bash
# 普通模式
python3 ~/.claude/hooks/acs_lite.py init my-task "dir1,dir2"

# Proposal 模式
python3 ~/.claude/hooks/acs_lite.py init my-task "dir1,dir2" --proposal
```

## 3. Lock 锁定状态

| 状态 | 触发条件 | 效果 |
|------|---------|------|
| locked: NO | window_score < 80 | 正常运行 |
| locked: YES | window_score >= 80 | 全部拒绝，需手动解锁 |

```bash
python3 ~/.claude/hooks/acs_lite.py unlock
# 或
rm ~/.claude/runtime/LOCKED ~/.claude/runtime/VIOLATIONS.json
echo '{"events":[]}' > ~/.claude/runtime/VIOLATIONS.json
```

## 4. 快速参考

| 场景 | 配置 |
|------|------|
| 日常开发 | MODE=ACTIVE + proposal=False |
| 灰度观察 | MODE=STRICT + proposal=True |
| 严格安全 | MODE=STRICT + proposal=False |
