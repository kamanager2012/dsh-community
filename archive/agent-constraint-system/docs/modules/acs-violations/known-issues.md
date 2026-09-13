# acs_violations — 已知问题

## clear_violations 不清空 (P0)

`v1.1.0:160-169` — 追加负分抵消，非真清空。每次 reset 后事件数组膨胀，下次任意 +100 重新锁。

**临时方案:** 手动 `echo '{"events":[]}' > VIOLATIONS.json`

**计划修复:** v1.2.0

## 滑动窗口仅 10 事件

高频操作（如批量 Shadow Workspace 写入）可能让窗口塞满小的 25 分事件导致不合规锁。

**临时方案:** 提高 `ACS_WINDOW_SIZE` 环境变量
