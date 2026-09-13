# 插件调试与发布

## 隔离调试

为插件准备独立 DSH_HOME、临时 profile 和最小 workspace。先用不需要真实凭据的启动、配置导出和只读路径，最后才做真实请求。

每次调试只改变一个变量：插件版本、patch、profile、Provider 或任务文本。

## 生命周期检查

反复加载和卸载插件，观察：

- 工具是否重复注册；
- 监听器是否重复触发；
- 子进程是否遗留；
- 端口是否释放；
- session 事件是否重复；
- 配置树是否污染；
- 错误是否清楚。

## 兼容性

插件要记录依赖的：

- dsh 版本范围；
- Cordis API；
- context service keys；
- event names 和 dispatch mode；
- profile/bundle；
- Node/Python/平台；
- Provider 协议；
- 需要的权限和网络。

内部 context 或未发布事件不应被写成稳定兼容承诺。

## 发布检查

~~~text
源码/包版本：
许可证：
安装或加载说明：
工具/Provider 清单：
权限和数据流：
默认值：
失败和回滚：
测试命令：
兼容矩阵：
文档链接：
~~~

插件发布不是把包上传就结束。使用者需要知道它会增加什么能力和风险。
