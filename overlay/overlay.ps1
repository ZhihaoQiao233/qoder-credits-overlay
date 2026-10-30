Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class QoderWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int index, int newLong);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[QoderWin32]::SetProcessDPIAware() | Out-Null

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\QoderCreditsOverlay', [ref]$createdNew)
if (-not $createdNew) { exit }

function Brush([string]$hex) {
  return (New-Object System.Windows.Media.BrushConverter).ConvertFromString($hex)
}

function New-Label([double]$size, [string]$color, [string]$text) {
  $block = New-Object System.Windows.Controls.TextBlock
  $block.FontFamily = 'Microsoft YaHei UI'
  $block.FontSize = $size
  $block.Foreground = Brush $color
  $block.Text = $text
  return $block
}

function New-Panel {
  $window = New-Object System.Windows.Window
  $window.WindowStyle = 'None'
  $window.AllowsTransparency = $true
  $window.Background = Brush '#00000000'
  $window.Topmost = $false
  $window.ShowInTaskbar = $false
  $window.ResizeMode = 'NoResize'
  $window.ShowActivated = $false
  $window.WindowStartupLocation = 'Manual'
  $window.Left = -4000
  $window.Top = -4000

  $border = New-Object System.Windows.Controls.Border
  $border.Background = Brush '#F21B1B1E'
  $border.BorderBrush = Brush '#33FFFFFF'
  $border.BorderThickness = 1
  $border.CornerRadius = 14
  $border.Padding = '16,12,16,10'
  $window.Content = $border

  return @($window, $border)
}

$dataDir = Join-Path $env:LOCALAPPDATA 'QoderCredits'
$statePath = Join-Path $dataDir 'state.json'
$errorPath = Join-Path $dataDir 'error.log'
$posPath = Join-Path $dataDir 'overlay-pos.json'

function Read-SharedJson([string]$filePath) {
  $stream = $null
  $reader = $null
  try {
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = [System.IO.File]::Open($filePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    return ($reader.ReadToEnd() | ConvertFrom-Json)
  } finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

# 胶囊相对 Qoder 窗口左上角的偏移，拖动后记住，下次启动还在老地方。
$script:posDx = $null
$script:posDy = $null

function Read-SavedPosition {
  if (-not (Test-Path -LiteralPath $posPath)) { return }
  try {
    $saved = Get-Content -LiteralPath $posPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    $script:posDx = [int]$saved.dx
    $script:posDy = [int]$saved.dy
  } catch {}
}

function Save-SavedPosition {
  try {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $temporary = "$posPath.tmp"
    Set-Content -LiteralPath $temporary -Encoding UTF8 -Value (ConvertTo-Json @{ dx = $script:posDx; dy = $script:posDy })
    Move-Item -LiteralPath $temporary -Destination $posPath -Force
  } catch {}
}

$chipPair = New-Panel
$chip = $chipPair[0]
$chipBorder = $chipPair[1]
$chip.Width = 64
$chip.Height = 48
$chipBorder.CornerRadius = 12
$chipBorder.Padding = '0,5,0,5'

$chipStack = New-Object System.Windows.Controls.StackPanel
$chipStack.HorizontalAlignment = 'Center'
$chipBorder.Child = $chipStack

$chipLabel = New-Label 9 '#99FFFFFF' '积分'
$chipLabel.HorizontalAlignment = 'Center'
$chipStack.Children.Add($chipLabel) | Out-Null

$chipValue = New-Label 16 '#FFFFFFFF' '--'
$chipValue.FontWeight = 'SemiBold'
$chipValue.HorizontalAlignment = 'Center'
$chipValue.Margin = '0,-3,0,0'
$chipStack.Children.Add($chipValue) | Out-Null

$cardPair = New-Panel
$window = $cardPair[0]
$border = $cardPair[1]
$window.Title = 'Qoder 积分'
$window.Width = 320
$window.Height = 206

$stack = New-Object System.Windows.Controls.StackPanel
$border.Child = $stack

$titleRow = New-Object System.Windows.Controls.DockPanel
$title = New-Label 13 '#CCFFFFFF' 'Qoder 积分'
$hint = New-Label 10 '#66FFFFFF' '拖动移动 · 右键收起'
[System.Windows.Controls.DockPanel]::SetDock($hint, 'Right')
$titleRow.Children.Add($hint) | Out-Null
$titleRow.Children.Add($title) | Out-Null
$titleRow.Margin = '0,0,0,8'
$stack.Children.Add($titleRow) | Out-Null

$taskLabel = New-Label 11 '#99FFFFFF' '本次任务'
$taskLabel.Margin = '0,0,0,1'
$stack.Children.Add($taskLabel) | Out-Null

$taskValue = New-Label 28 '#FFFFFFFF' '--'
$taskValue.FontWeight = 'SemiBold'
$taskValue.Margin = '0,-4,0,2'
$stack.Children.Add($taskValue) | Out-Null

$modelValue = New-Label 10 '#99FFFFFF' ''
$modelValue.Margin = '0,0,0,2'
$stack.Children.Add($modelValue) | Out-Null

$convLabel = New-Label 11 '#99FFFFFF' '本次对话'
$convLabel.Margin = '0,2,0,0'
$stack.Children.Add($convLabel) | Out-Null

$convValue = New-Label 15 '#DDDDDDDD' '--'
$convValue.Margin = '0,1,0,4'
$stack.Children.Add($convValue) | Out-Null

$statusRow = New-Object System.Windows.Controls.DockPanel
$statusValue = New-Label 10 '#88FFFFFF' '等待 Qoder 任务'
$calibValue = New-Label 10 '#88FFFFFF' ''
[System.Windows.Controls.DockPanel]::SetDock($calibValue, 'Right')
$statusRow.Children.Add($calibValue) | Out-Null
$statusRow.Children.Add($statusValue) | Out-Null
$stack.Children.Add($statusRow) | Out-Null

$toastPair = New-Panel
$toast = $toastPair[0]
$toastBorder = $toastPair[1]
$toast.Width = 320
$toast.Height = 96

$toastStack = New-Object System.Windows.Controls.StackPanel
$toastBorder.Child = $toastStack

$toastTitle = New-Label 10 '#99FFFFFF' '任务完成'
$toastStack.Children.Add($toastTitle) | Out-Null

$toastTask = New-Label 22 '#FFFFFFFF' ''
$toastTask.FontWeight = 'SemiBold'
$toastTask.Margin = '0,-2,0,0'
$toastStack.Children.Add($toastTask) | Out-Null

$toastConv = New-Label 10 '#88FFFFFF' ''
$toastConv.Margin = '0,2,0,0'
$toastStack.Children.Add($toastConv) | Out-Null

$script:toastPending = $false
$script:expanded = $false
$script:visible = $false
$script:scale = 1.0
$script:targetOnScreen = $false
$script:ownerHwnd = [IntPtr]::Zero

function Bind-QoderOwner([IntPtr]$qoderHwnd) {
  if ($qoderHwnd -eq [IntPtr]::Zero -or $script:ownerHwnd -eq $qoderHwnd) { return }
  foreach ($panel in @($chip, $window, $toast)) {
    # Native ownership also works across the Qoder and WPF processes.
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($panel)
    $helper.Owner = $qoderHwnd
  }
  $script:ownerHwnd = $qoderHwnd
}

function Add-NoActivateStyle([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return }
  $style = [QoderWin32]::GetWindowLong($handle, -20)
  [QoderWin32]::SetWindowLong($handle, -20, $style -bor 0x08000080) | Out-Null
}

$script:chipHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($chip)).EnsureHandle()
Add-NoActivateStyle $script:chipHwnd
$script:cardHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($window)).EnsureHandle()
Add-NoActivateStyle $script:cardHwnd
$script:toastHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($toast)).EnsureHandle()
Add-NoActivateStyle $script:toastHwnd

$initRect = New-Object QoderWin32+RECT
if ([QoderWin32]::GetWindowRect($script:chipHwnd, [ref]$initRect)) {
  $initWidth = $initRect.Right - $initRect.Left
  if ($initWidth -gt 0) { $script:scale = $initWidth / $chip.Width }
}

function Find-QoderWindow {
  $script:targetOnScreen = $false
  $fallback = [IntPtr]::Zero
  foreach ($proc in @(Get-Process -Name Qoder -ErrorAction SilentlyContinue)) {
    $handle = $proc.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { continue }
    if ($fallback -eq [IntPtr]::Zero) {
      $fallback = $handle
    }
    # Electron 有多个同名进程，优先认真正显示在屏幕上的那个窗口。
    if ([QoderWin32]::IsWindowVisible($handle) -and (-not [QoderWin32]::IsIconic($handle))) {
      $script:targetOnScreen = $true
      return $handle
    }
  }
  return $fallback
}

function Get-WindowSize([IntPtr]$handle, [double]$fallbackWidth, [double]$fallbackHeight) {
  $rect = New-Object QoderWin32+RECT
  if ([QoderWin32]::GetWindowRect($handle, [ref]$rect)) {
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -gt 0 -and $height -gt 0) { return @($width, $height) }
  }
  return @([int]($fallbackWidth * $script:scale), [int]($fallbackHeight * $script:scale))
}

function Move-Panel([IntPtr]$handle, [int]$x, [int]$y) {
  if ($handle -eq [IntPtr]::Zero) { return }
  # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER.
  [QoderWin32]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, 0, 0, 0x215) | Out-Null
}

function Get-CursorPoint {
  $point = New-Object QoderWin32+POINT
  if ([QoderWin32]::GetCursorPos([ref]$point)) { return @($point.X, $point.Y) }
  return @($null, $null)
}

$script:dragging = $false
$script:dragMoved = $false
$script:dragStartX = 0
$script:dragStartY = 0
$script:dragChipX = 0
$script:dragChipY = 0

function Save-ChipPosition {
  $qoderHwnd = Find-QoderWindow
  if ($qoderHwnd -eq [IntPtr]::Zero) { return }
  $qoderRect = New-Object QoderWin32+RECT
  $chipRect = New-Object QoderWin32+RECT
  if (-not [QoderWin32]::GetWindowRect($qoderHwnd, [ref]$qoderRect)) { return }
  if (-not [QoderWin32]::GetWindowRect($script:chipHwnd, [ref]$chipRect)) { return }
  $script:posDx = $chipRect.Left - $qoderRect.Left
  $script:posDy = $chipRect.Top - $qoderRect.Top
  Save-SavedPosition
}

$chipBorder.Add_MouseLeftButtonDown({
  $cursor = Get-CursorPoint
  if ($null -eq $cursor[0]) { return }
  $rect = New-Object QoderWin32+RECT
  if (-not [QoderWin32]::GetWindowRect($script:chipHwnd, [ref]$rect)) { return }
  $script:dragging = $true
  $script:dragMoved = $false
  $script:dragStartX = $cursor[0]
  $script:dragStartY = $cursor[1]
  $script:dragChipX = $rect.Left
  $script:dragChipY = $rect.Top
  $chipBorder.CaptureMouse()
})

$chipBorder.Add_MouseMove({
  if (-not $script:dragging) { return }
  $cursor = Get-CursorPoint
  if ($null -eq $cursor[0]) { return }
  $dx = $cursor[0] - $script:dragStartX
  $dy = $cursor[1] - $script:dragStartY
  if ([Math]::Abs($dx) -gt 3 -or [Math]::Abs($dy) -gt 3) { $script:dragMoved = $true }
  Move-Panel $script:chipHwnd ($script:dragChipX + $dx) ($script:dragChipY + $dy)
})

$chipBorder.Add_MouseLeftButtonUp({
  if (-not $script:dragging) { return }
  $script:dragging = $false
  $chipBorder.ReleaseMouseCapture()
  if ($script:dragMoved) {
    # 拖动过就只记位置，不当成点击展开。
    Save-ChipPosition
    & $dock
    return
  }
  $script:expanded = -not $script:expanded
  if ($script:expanded) {
    $window.Show()
    if ($script:visible) { & $dock }
  } else {
    $window.Hide()
  }
})

$border.Add_MouseRightButtonUp({
  $script:expanded = $false
  $window.Hide()
})

$toastBorder.Add_MouseLeftButtonUp({ $toast.Hide() })
$toastBorder.Add_MouseRightButtonUp({ $toast.Hide() })

$toastTimer = New-Object System.Windows.Threading.DispatcherTimer
$toastTimer.Interval = [TimeSpan]::FromSeconds(6)
$toastTimer.Add_Tick({ $toastTimer.Stop(); $toast.Hide() })

$dock = {
  try {
    $qoderHwnd = Find-QoderWindow
    Bind-QoderOwner $qoderHwnd

    $chipSize = Get-WindowSize $script:chipHwnd $chip.Width $chip.Height
    $script:scale = $chipSize[0] / $chip.Width
    $cardSize = Get-WindowSize $script:cardHwnd $window.Width $window.Height

    $work = [System.Windows.SystemParameters]::WorkArea
    $maxRight = [int]($work.Right * $script:scale)
    $maxBottom = [int]($work.Bottom * $script:scale)
    $maxTop = [int]($work.Top * $script:scale)
    $edgeInset = [int](10 * $script:scale)

    if (-not $script:targetOnScreen) {
      # Qoder 最小化或收进托盘时胶囊一起消失，不要浮在桌面上。
      if ($script:visible) {
        $window.Hide()
        $chip.Hide()
        $script:visible = $false
        $script:expanded = $false
      }
      $toast.Hide()
      $toastTimer.Stop()
      $script:toastPending = $false
      return
    }

    # 拖动过程中不抢位置，松手后再归位。
    if ($script:dragging) { return }

    $qoderRect = New-Object QoderWin32+RECT
    if (-not [QoderWin32]::GetWindowRect($qoderHwnd, [ref]$qoderRect)) { return }
    $right = [Math]::Min($qoderRect.Right, $maxRight)
    $bottom = [Math]::Min($qoderRect.Bottom, $maxBottom)
    $top = [Math]::Max($qoderRect.Top, $maxTop)
    $left = [Math]::Max($qoderRect.Left, 0)

    if ($null -ne $script:posDx) {
      $chipX = $qoderRect.Left + $script:posDx
      $chipY = $qoderRect.Top + $script:posDy
    } else {
      # 默认贴左边：Qoder 自己的 Credits 面板在右上角，贴右边必然压住它。
      $chipX = $left + $edgeInset
      $chipY = [int](($top + $bottom) / 2 - $chipSize[1] / 2)
    }

    # 始终留在 Qoder 窗口里，别跑到桌面上去，也别盖住窗口边框。
    $maxX = $right - $chipSize[0] - 4
    if ($maxX -lt $left) { $maxX = $left }
    if ($chipX -lt $left) { $chipX = $left }
    if ($chipX -gt $maxX) { $chipX = $maxX }
    $maxY = $bottom - $chipSize[1] - 4
    if ($maxY -lt $top) { $maxY = $top }
    if ($chipY -lt $top) { $chipY = $top }
    if ($chipY -gt $maxY) { $chipY = $maxY }
    Move-Panel $script:chipHwnd $chipX $chipY

    $gap = [int](8 * $script:scale)
    $cardX = $chipX + $chipSize[0] + $gap
    if (($cardX + $cardSize[0]) -gt $maxRight) {
      $cardX = $chipX - $cardSize[0] - $gap
    }
    if ($cardX -lt 0) { $cardX = 0 }
    $cardY = [int]($chipY + $chipSize[1] / 2 - $cardSize[1] / 2)
    if ($cardY -lt $maxTop) { $cardY = $maxTop }
    $cardMaxY = $maxBottom - $cardSize[1]
    if ($cardMaxY -gt $maxTop -and $cardY -gt $cardMaxY) { $cardY = $cardMaxY }
    Move-Panel $script:cardHwnd $cardX $cardY

    if ($script:toastPending) {
      $toastSize = Get-WindowSize $script:toastHwnd $toast.Width $toast.Height
      $toastX = $chipX
      if (($toastX + $toastSize[0]) -gt $maxRight) {
        $toastX = [Math]::Max(0, $maxRight - $toastSize[0])
      }
      $toastY = $chipY - $toastSize[1] - [int](10 * $script:scale)
      if ($toastY -lt $maxTop) { $toastY = $maxTop }
      Move-Panel $script:toastHwnd $toastX $toastY
      $toast.Show()
      $toastTimer.Stop()
      $toastTimer.Start()
      $script:toastPending = $false
    }

    if (-not $script:visible) {
      $chip.Show()
      $script:visible = $true
    }
    if ($script:expanded) { $window.Show() }
  } catch {
    try {
      New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
      Add-Content -LiteralPath $errorPath -Encoding UTF8 -Value ("{0} dock {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $_.Exception.Message)
    } catch {}
  }
}

function Format-ModelBreakdown($byModel) {
  if ($null -eq $byModel) { return '' }
  $entries = @()
  foreach ($property in $byModel.PSObject.Properties) {
    $total = [double]$property.Value.total
    if ($total -le 0) { continue }
    $entries += [pscustomobject]@{ name = $property.Name; total = $total }
  }
  if ($entries.Count -eq 0) { return '' }
  $parts = @()
  foreach ($entry in ($entries | Sort-Object -Property total -Descending)) {
    $parts += ('{0} {1:F2}' -f $entry.name, $entry.total)
  }
  return ($parts -join ' · ')
}

function Format-HiddenTotal($byModel) {
  if ($null -eq $byModel) { return 0.0 }
  $total = 0.0
  foreach ($property in $byModel.PSObject.Properties) {
    $total += [double]$property.Value.hidden
  }
  return $total
}

$script:lastCompletedAt = $null
$script:baselineSet = $false

$update = {
  try {
    if (-not (Test-Path -LiteralPath $statePath)) {
      $chipValue.Text = '--'
      $taskValue.Text = '--'
      $modelValue.Text = ''
      $convValue.Text = '--'
      $statusValue.Text = '等待 Qoder 任务'
      $statusValue.Foreground = Brush '#88FFFFFF'
      $calibValue.Text = ''
      return
    }

    $state = Read-SharedJson $statePath
    $session = $null
    if ($state.currentSessionId -and $state.sessions) {
      $prop = $state.sessions.PSObject.Properties[$state.currentSessionId]
      if ($prop) { $session = $prop.Value }
    }

    if ($session) {
      # Only recorded server charges are shown; background completion is unknown.
      $task = [double]$session.taskCredits
      $conversation = [double]$session.conversationCredits
      if ($null -ne $session.exactConversationCredits) {
        $conversation = [double]$session.exactConversationCredits
      }
      $chipValue.Text = ('{0:F2}' -f $task)
      $taskValue.Text = ('{0:F2}' -f $task)
      $taskLabel.Text = '本轮消耗'
      $convValue.Text = ('{0:F2} Credits' -f $conversation)
      $modelValue.Text = Format-ModelBreakdown $session.taskByModel
      $hiddenTotal = Format-HiddenTotal $session.taskByModel

      switch ([string]$session.status) {
        'running' {
          $statusValue.Text = '运行中'
          $statusValue.Foreground = Brush '#FF6BE59A'
        }
        'completed' {
          $statusValue.Text = '已完成'
          $statusValue.Foreground = Brush '#FF8AB4FF'
        }
        default {
          $statusValue.Text = '等待 Qoder 任务'
          $statusValue.Foreground = Brush '#88FFFFFF'
        }
      }

      $calibValue.Foreground = Brush '#88FFFFFF'
      $calibValue.Text = '实时统计'
      if ($session.status -eq 'completed') { $calibValue.Text = '' }
      if ($session.taskAttribution -eq 'transcript-only') { $calibValue.Text = '同步中' }
      if ($session.ledgerReconciliation -and [double]$session.ledgerReconciliation.unmatchedCredits -gt 0.0001) {
        $calibValue.Text = '同步中'
      }
    } else {
      $chipValue.Text = '--'
      $taskValue.Text = '--'
      $modelValue.Text = ''
      $convValue.Text = '--'
      $statusValue.Text = '等待 Qoder 任务'
      $statusValue.Foreground = Brush '#88FFFFFF'
      $calibValue.Text = ''
    }

    $completedAt = $null
    if ($state.lastCompleted) { $completedAt = [string]$state.lastCompleted.at }
    if ($completedAt) {
      if (-not $script:baselineSet) {
        $script:lastCompletedAt = $completedAt
        $script:baselineSet = $true
      } elseif ($completedAt -ne $script:lastCompletedAt) {
        $script:lastCompletedAt = $completedAt
        $done = [double]$state.lastCompleted.taskCredits
        $toastTask.Text = ('本轮消耗 {0:F2} Credits' -f $done)
        if ($session) {
          $convDone = [double]$session.conversationCredits
          if ($null -ne $session.exactConversationCredits) {
            $convDone = [double]$session.exactConversationCredits
          }
          $toastConv.Text = ('本次对话 {0:F2} Credits' -f $convDone)
        } else {
          $toastConv.Text = ''
        }
        $script:toastPending = $true
      }
    } else {
      $script:baselineSet = $true
    }
  } catch {
    try {
      New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
      Add-Content -LiteralPath $errorPath -Encoding UTF8 -Value ("{0} overlay {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $_.Exception.Message)
    } catch {}
    $chipValue.Text = '!'
    $statusValue.Text = '读取状态失败'
    $statusValue.Foreground = Brush '#FFFF8A80'
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(1)
$timer.Add_Tick($update)
$timer.Start()

$dockTimer = New-Object System.Windows.Threading.DispatcherTimer
$dockTimer.Interval = [TimeSpan]::FromMilliseconds(200)
$dockTimer.Add_Tick($dock)
$dockTimer.Start()

$chip.Add_Loaded({ & $update })
$chip.Add_Closed({
  $timer.Stop()
  $dockTimer.Stop()
  $toastTimer.Stop()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
})

Read-SavedPosition
& $update
[System.Windows.Threading.Dispatcher]::Run()
