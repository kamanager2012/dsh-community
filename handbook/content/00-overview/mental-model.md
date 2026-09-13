# 心智模型：一次 dsh 运行里到底有什么

理解下面这张关系图，比背命令更有用：

~~~text
运行环境
├── DSH_HOME
│   ├── settings.yaml          Provider、模型、用户设置
│   ├── .credentials.yaml      凭据存储
│   ├── profiles/               profile 与安装的插件
│   └── sessions/               会话持久化位置（按组合而定）
├── cwd / workspace              Agent 工作目录
└── 进程环境                     密钥变量、代理变量、平台设置

启动器
├── profile: web / headless / 自定义 profile
├── bundle: base + web/headless + 自定义层
├── cordis.patch.yml             对组合配置做覆盖
└── overlay                     本次运行的临时覆盖

任务运行时
├── Provider / model              发送模型请求
├── Agent                         管理轮次和下一步动作
├── tools                         文件、搜索、Shell、计划、委派等
├── permission / approval         允许、询问、拒绝
├── sandbox / filesystem          进程实际可见范围
└── session                       事件、历史、恢复和日志
~~~

## 1. 进程、cwd 和 workspace

进程启动目录是默认 cwd。Web UI 还要求用户显式选择 workspace；这两个位置可能相同，也可能不同。

不要用“我是在项目目录启动的”代替检查 workspace。任务开始前确认：

1. 终端里的 pwd；
2. Web UI 当前选中的工作区；
3. 工具执行时实际使用的 cwd；
4. workspace 外是否存在被继承的临时目录、环境文件或挂载。

对只读任务，最好使用一个没有未提交改动的 checkout。对写入任务，使用临时分支、可恢复副本或容器。

## 2. Provider、模型和凭据引用

模型选择器里显示的是可用路由的结果。一个模型选择并不只代表名称，它还绑定：

- Provider ID；
- API 协议；
- Base URL；
- 凭据引用；
- 输入模态；
- 可能的推理、超时和上下文设置。

凭据值和配置引用是两件事。settings 可以保存某个凭据引用，但不应把密钥值写入仓库、任务或日志。

## 3. Agent、turn 和 step

可以用三个层次理解运行：

- **Agent**：当前拥有输入、工具和状态的执行主体；
- **turn**：从领取一次用户/系统输入开始，到没有待处理工作并关闭的轮次；
- **step**：一次模型请求及其工具调用链。

一个 turn 可能包含多个 step；一个 step 可能包含多个工具调用。只看最终回答无法重建中间发生了什么，长任务必须结合 session 事件、工具结果和工作区 diff。

## 4. Profile、bundle 和 patch

profile 是一个具名的运行时组合，通常位于 DSH_HOME 中。bundle 是可分发的组合配置。patch 用 ID 定位已有条目并替换或插入配置。

一个常见的叠加顺序是：

~~~text
空配置
  → profile 声明的 bundle
  → profile patch
  → DSH_HOME 级 patch
  → 命令行 overlay
  → 实际启动树
~~~

因此，同一个 `dsh web` 命令在不同 DSH_HOME、profile 或 patch 下可能拥有不同工具和权限。需要解释行为时，先导出实际配置树，而不是只看默认文档。

## 5. Session 是事件源

session 不是一个可以随意覆盖的 JSON 对象。它更接近追加事件日志：

~~~text
用户消息
→ agent 事件
→ 模型请求与流
→ 工具调用与结果
→ turn/step 结束
→ 派生历史、UI、恢复和摘要
~~~

模型看到的历史、Web UI 展示、fork 的父子关系和很多恢复信息都从事件流派生。加入新的模型可见输入时，不能只改内存变量而不考虑持久化和重放。

## 6. 发生问题时的定位顺序

按从外到内的顺序定位：

1. 进程是否启动，参数是否由当前版本支持；
2. profile 和实际配置树是什么；
3. Provider 是否保存，凭据引用是否可解析；
4. workspace、cwd 和权限是否正确；
5. 工具是否被当前组合加载；
6. session 是否存在、是否可继续；
7. 模型请求是否失败；
8. 工具动作和外部验收是否失败。

不要一开始就把所有问题归咎于模型。很多“模型不工作”实际是 workspace 未选择、凭据缺失、工具未加载或旧 session 状态不一致。
