# Windows、WSL 与路径问题

## 先决定运行位置

在 Windows 上可以把 dsh 运行在：

- Windows 原生 Node/Python；
- WSL Linux；
- 容器或远程 Linux。

不要只因为项目文件在某个盘符，就默认所有运行时都应该在 Windows 原生环境中运行。Web、CLI、SDK、PTY、沙箱和文件系统后端的支持范围可能不同。

如果使用 Python SDK，官方示例中的持久 PTY 组合需要 POSIX 终端环境；Windows 上不要未经核对就假设等价。

## WSL 的路径转换

Windows 路径和 WSL 路径不是一回事：

~~~text
Windows: C:\work\project
WSL:     /mnt/c/work/project
~~~

在 WSL shell 中运行 dsh 时，任务文本、cwd、workspace、session_root 和日志路径都应使用 WSL 能访问的路径。不要把 C:\... 原样复制到 Linux 命令里。

反过来，在 PowerShell 中不要把 /mnt/c/... 当作普通 Windows 路径使用。跨环境传递路径时写明：

~~~text
运行时：Windows 或 WSL
workspace：该运行时可解析的绝对路径
session_root：同一运行时可写的目录
文件归属：Windows 还是 Linux
~~~

## 跨文件系统的性能和权限

把大型仓库放在 /mnt/c 下并由 WSL 频繁扫描，可能比放在 WSL 文件系统中慢。慢不一定是模型问题；先用本地只读命令确认文件扫描本身的耗时。

还要注意：

- Git 的换行和可执行位；
- Windows 杀毒软件或索引器锁定文件；
- WSL 与 Windows 进程看到的环境变量不同；
- 凭据文件的权限语义不同；
- 端口监听地址可能只在一侧可访问。

## 浏览器访问

如果 dsh 在 WSL 中监听 127.0.0.1，Windows 浏览器通常可以访问转发的本机端口，但不要据此把服务暴露给局域网。遇到页面打不开，先在运行 dsh 的同一环境中用 curl 检查，再检查 Windows 防火墙和端口转发。

## 建议的排错顺序

~~~bash
node --version
pwd
printf '%s\n' "$PWD"
git status --short
curl -I http://127.0.0.1:3080
~~~

PowerShell 等价命令按当前 shell 改写，不要把一段 Bash 直接粘贴到 PowerShell。

如果路径中有空格、非 ASCII 字符或括号，始终使用引号。任务中也要明确 workspace，而不是让 Agent 自己寻找“可能的项目目录”。
