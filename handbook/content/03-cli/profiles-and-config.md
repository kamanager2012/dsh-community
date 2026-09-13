# Profile、Bundle 与配置导出

## Profile 是什么

profile 是一个具名的运行时组合。官方资料把 web 和 headless 作为随发行版交付的模板；profile 还可以包含组合包、树外插件和自己的 cordis.patch.yml。

同一条命令的实际能力取决于：

- 当前 DSH_HOME；
- profile 名称；
- 已安装 bundle；
- profile patch；
- home 级 patch；
- 命令行 overlay；
- 当前平台和环境变量。

## Bundle 是什么

bundle 是组合配置及挂载代码的分发形式。它可以增加模型适配器、工具、持久化、沙箱、审批、Web 应用或 headless 运行器。

不要把 bundle 当作普通 npm 依赖的同义词。npm 负责分发包，dsh 的 bundle/profile 字段负责说明这些包如何进入插件树。

## 叠加顺序

常见叠加顺序可以简化为：

~~~text
空插件树
  → profile 中列出的 bundle
  → profile cordis.patch.yml
  → DSH_HOME 级 patch
  → --patch overlay
  → 运行时实例
~~~

patch 通常按 ID 找到配置条目，然后替换整个 config 或插入新的条目。一个看似只改了一个字段的 patch，如果写成完整替换，可能同时丢掉原本的工具或安全配置。

## 先导出再改

~~~bash
npx @deepseek-ai/dsh --profile web --dump-config
~~~

导出后先回答：

- 当前有哪些 Provider 和模型适配器；
- 文件系统、Shell、终端和搜索工具有哪些；
- 权限、审批和沙箱默认值是什么；
- session 和凭据存在哪里；
- Web 或 headless 的入口如何组合。

只在知道要改哪一行时再写 patch。patch 放到版本库前，删除密钥值、机器路径和个人信息。

## 环境差异

下面这些变量会让同一 profile 表现不同：

- DSH_HOME；
- Provider 凭据环境变量；
- DSH_PERMISSION_MODE 等权限后备值；
- endpoint 和代理；
- 操作系统；
- 可用的子进程、PTY 和沙箱；
- 运行时是否来自 npm 或源码。

排查“我的机器和同事的不一样”时，先比较上述输入，再比较任务文本。

## 自定义 profile 的最低要求

团队 profile 至少应有：

~~~text
用途：
允许的 workspace：
允许的工具：
权限与审批：
Provider 与模型：
日志与 session 目录：
升级方式：
回滚方式：
维护人：
~~~

没有这些说明的 profile 只是一份个人配置，不宜直接用于 CI 或共享服务。
