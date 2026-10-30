# Qoder Credits Overlay

Qoder Credits Overlay 是一个面向 Windows 的 Qoder 积分悬浮窗工具，可实时显示本轮 Credits 消耗、分模型明细和会话累计，并在任务完成后提供消耗提示。窗口随 Qoder 移动和切换，支持展开查看、拖动定位及位置记忆。

![积分悬浮窗](docs/screenshot-chip.png)

## 安装配置

安装 Node.js 24 或更高版本后，在 PowerShell 中运行：

```powershell
git clone https://github.com/ZhihaoQiao233/qoder-credits-overlay.git
cd qoder-credits-overlay
npm run install-hooks
```

项目无第三方依赖，无需执行 `npm install`。

安装完成后，在 Qoder 中提交一条新消息，悬浮窗会自动启动。也可以在项目目录手动启动：

```powershell
npm run watch
```

当前仅支持 Windows，已验证环境为 Windows 11、PowerShell 5.1、Node.js 24 和 Qoder Desktop 0.4.11。

## 使用说明

胶囊默认位于 Qoder 窗口左侧，可拖动调整位置，重启后保留。点击胶囊展开明细，右键明细卡收起。

悬浮窗跟随 Qoder 移动，切换到其他窗口时随 Qoder 一起被遮挡，最小化时隐藏。任务运行期间持续更新用量，完成后显示本轮消耗提示。

首次安装后需提交一条消息，以获取会话路径。界面显示“同步中”时，表示尚未读取到对应数据。

## 数据来源

积分来自 Qoder 的本地计费记录，免费请求计为 0，不通过 token 数和单价估算。

主对话以及上下文压缩、记忆生成、技能演进等后台调用，均通过请求 ID 关联到对应轮次。后台计费记录可能晚于主回复写入，显示数值会随记录更新。

程序不联网，无需提供账号 Token 或 Cookie。它会读取本地会话文件和日志，缓存仅保存计费信息，不保存对话正文。运行缓存、窗口位置和错误日志位于：

```text
%LOCALAPPDATA%\QoderCredits
```

<details>
<summary>统计原理与对账工具</summary>

主对话取会话记录中的 `usage.credits`，后台调用取 worker 日志中的逐请求计费字段，只有 `billable=true` 才计入消耗。会话累计还会读取客户端的本地用量总账，日志和总账之间可能有落盘时间差。

总账读取复用了客户端内置的固定密钥，不是用户的登录凭据。如果客户端更换密钥，总账对账会停用，日志和会话记录的统计仍会继续。

需要核对某个会话时，可以运行：

```powershell
node tools/selfcheck.mjs "C:/path/to/session.jsonl" "C:/path/to/workspace"
node tools/audit-usage.mjs "C:/path/to/session.jsonl" "C:/path/to/workspace"
```

`selfcheck.mjs` 查看总账与会话记录的差额，`audit-usage.mjs` 列出逐轮计费归属。输出包含本机路径和会话 ID，分享前请检查内容。

</details>

## 配置与卸载

安装时会在 `%USERPROFILE%\.qoder\settings.json` 中注册三个 Hook，接收任务开始、结束和会话关闭事件。运行期间需保留项目目录；移动目录后，重新执行 `npm run install-hooks`。

卸载时，在项目目录运行：

```powershell
npm run uninstall-hooks
```

该命令移除本项目的 Hook，保留其他设置。已运行的悬浮窗和监视器需另行结束，本地缓存不会自动删除。

## 问题反馈

Qoder 升级可能改变本地日志格式。如遇用量不更新、窗口定位异常等问题，可在 [Issues](https://github.com/ZhihaoQiao233/qoder-credits-overlay/issues) 中附上 Qoder 版本、问题描述和截图，请勿上传完整会话日志。

个人维护的非官方工具。[MIT License](LICENSE)。
