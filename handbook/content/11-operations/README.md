# 运维与团队使用

个人能跑起来，不代表团队能稳定使用。团队需要把版本、Provider、权限、workspace、日志、验收和升级放进同一套规则。

## 本章路径

- [团队运行规范](team.md)
- [CI 与流水线](ci.md)
- [日志与可观测性](observability.md)
- [故障分诊](troubleshooting.md)
- [Community Labs handoff](community-labs-handoff.md)
- [升级和回滚](../01-installation/upgrades.md)

## 运维的最低交付物

~~~text
版本记录：
运行入口：
profile：
Provider：
模型：
权限：
workspace 策略：
session/log 策略：
验收器：
升级负责人：
故障联系人：
~~~

没有这些信息时，任务失败很难重现，也很难判断是模型、配置还是环境问题。
