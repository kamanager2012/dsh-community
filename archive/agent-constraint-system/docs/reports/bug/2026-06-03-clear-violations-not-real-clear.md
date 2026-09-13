# BUG: clear_violations 不清空 events

- **严重度:** P0
- **模块:** acs_violations.py:160-169
- **发现:** 2026-06-03（循环自锁事故中暴露）

## 现象

`reset --force` 后 violations window_score 归零，但 events 数组只追加了 `score=-old` 的记录。下次任意 +100 事件使 sum 再次过线。

## 触发

```python
# acs_violations.py:164
v.setdefault("events", []).append({
    "reason": reason, "score": -old, "ts": time.time(),
})
```

应该 `v["events"] = []`。

## 影响

- 每次 reset 只短暂解锁
- 高频违规场景下持续循环锁

## 修复

`line 164`: 替换为 `v["events"] = []`
