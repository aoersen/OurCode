# CUA 探针（Windows）

> 目的：在写任何生产代码之前，用本机真实窗口验证「Windows PowerShell 5.1 + UI Automation」
> 能否承担 OurCode 电脑操控 helper 的观察/动作/截图职责。结论用于
> [`docs/COMPUTER_USE.md`](../../../docs/COMPUTER_USE.md) 的后端选型。

## 文件

| 文件 | 作用 |
|---|---|
| `uia-probe.ps1` | 只读探针：枚举顶层窗口，打印指定窗口的 ControlView 子树（角色 / 名称 / AutomationId / Value / 可用 pattern） |
| `target-wpf.ps1` | 自建 WPF 目标窗口（TextBox + Button + TextBlock），有完整 UIA peer，不会被系统应用干扰 |
| `drive-probe.ps1` | 端到端探针：启动目标窗口 → UIA 观察 → `ValuePattern.SetValue` → `InvokePattern.Invoke` → `SetForegroundWindow` + `SendInput` Unicode 补全 → 回读 → GDI 截图 → 关闭 |

## 运行

```powershell
# 观察任意窗口（参数是窗口标题子串）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uia-probe.ps1 "文件资源管理器"

# 端到端（自己拉起目标窗口，不碰用户文档）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\drive-probe.ps1
```

> 脚本必须保存为 **UTF-8 with BOM**：`powershell.exe` 5.1 读取无 BOM 的 UTF-8 时会按 ANSI 解码，
> 中文和引号会被拆坏。`-File` 传参同理。

## 本机实测（2026-11-02，Windows 11 / 双屏 / 远程桌面会话）

| 观察对象 | 结果 |
|---|---|
| 顶层窗口枚举（39 个） | 232 ms（进程冷启动含 `Add-Type` 为 534 ms） |
| 资源管理器（`CabinetWClass`，经典 Win32） | 树完整：导航窗格 / 项目视图 / 地址栏 edit / 后退后退刷新 / 删除 / 排序 / 查看，按钮名里带快捷键提示 |
| WPF 目标窗口 | `edit(probeInput)` / `button(Submit)` / `text(probeEcho)`，7 节点，204–259 ms |
| 动作链路 | `SetValue` 成功；`Invoke` 成功并回读到 `echo:Hello 中文`；SetForegroundWindow + SetFocus + Unicode SendInput 成功；单轮 Set+Invoke+回读约 600 ms |
| 截图 | GDI `CopyFromScreen` 460×260 PNG 9.3 KB，窗口内容正确 |
| Edge / Electron（Chromium 内容区） | 只有 7–9 个 `pane` 占位节点，**拿不到网页可访问性树** |
| WinForms（MSAA 桥接） | 控件被暴露成 `pane`，没有 AutomationId，`ValuePattern` 不可用 |
| 最小化窗口 | `BoundingRectangle` 为 `Empty`，子树只剩 2 个节点 |
| `notepad.exe`（Win11 打包应用） | `Start-Process` 拿不到 `MainWindowHandle`（进程只是启动器） |

这些结果直接决定了方案里的三条硬规则：**窗口必须可见才能观察**、**Web/Electron 内容走 CDP 而不是 UIA**、
**App 身份按 UIA 名称/类名/pid 解析，不用进程句柄**。
