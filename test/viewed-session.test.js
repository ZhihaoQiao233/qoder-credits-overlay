import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../overlay/overlay.ps1', import.meta.url)).replaceAll("'", "''");
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const run = body => {
  const command = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors)
    if ($errors.Count) { throw $errors[0] }
    $names=@('Get-RouteSessionId','Select-ViewedSession','Brush','Format-ModelBreakdown','Format-HiddenTotal')
    $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names},$true) | ForEach-Object { Invoke-Expression $_.Extent.Text }
    ${body}
  `;
  const p = spawnSync('powershell.exe', ['-STA', '-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout.trim());
};

test('reads only a Qoder chat route, rejecting other pages and foreign origins', { skip: process.platform !== 'win32' }, () => {
  const routes = [
    `qoder-app://renderer/index.html?workbenchScope=primary#/chat/${a}?surface=conversation`,
    'qoder-app://renderer/index.html#/settings',
    `https://example.test/#/chat/${a}`,
    'qoder-app://renderer/index.html#/chat/',
    ''
  ];
  const result = run(`$routes='${JSON.stringify(routes)}' | ConvertFrom-Json
    $result=@(foreach($route in $routes){ if(Get-Command Get-RouteSessionId -ErrorAction SilentlyContinue){ Get-RouteSessionId $route }else{ $null } })
    ConvertTo-Json -InputObject $result -Compress`);
  assert.deepEqual(result, [a, null, null, null, null]);
});

test('shows the viewed conversation even when another session finishes and clears unknown views', { skip: process.platform !== 'win32' }, () => {
  const state = { currentSessionId: a, lastCompleted: { sessionId: a }, sessions: { [a]: { taskCredits: 90 }, [b]: { taskCredits: 2 } } };
  const result = run(`$state='${JSON.stringify(state)}' | ConvertFrom-Json
    $values=@(foreach($id in @('${b}','${a}','unknown','')){
      $s=$null
      if(Get-Command Select-ViewedSession -ErrorAction SilentlyContinue){$s=Select-ViewedSession $state $id}
      if($s){$s.taskCredits}else{$null}
    })
    ConvertTo-Json -InputObject $values -Compress`);
  assert.deepEqual(result, [2, 90, null, null]);
});

const updateHarness = `
  Add-Type -AssemblyName PresentationFramework
  foreach($name in @('chipLabel','chipValue','taskValue','modelValue','convValue','statusValue','calibValue','taskLabel','toastTask','toastConv')) {
    Set-Variable -Name $name -Value (New-Object System.Windows.Controls.TextBlock)
  }
  $toast=New-Object System.Windows.Window
  $toastTimer=New-Object System.Windows.Threading.DispatcherTimer
  $statePath='${script}'
  function Read-SharedJson { return $script:testState }
  function Find-QoderWindow { return [IntPtr]::Zero }
  function Get-ViewedSessionId { return $script:testViewedSessionId }
  $script:viewedSessionId=$null
  $script:lastCompletedAt=$null
  $script:baselineSet=$false
  $script:toastPending=$false
  $assignment=$ast.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$update'},$true)
  Invoke-Expression $assignment.Extent.Text
`;

test('official display takes precedence over ledger residuals and marks offline values as cached', { skip: process.platform !== 'win32' }, () => {
  const state = { officialSync: { status: 'synced' }, lastCompleted: null, sessions: {
    [a]: { taskCredits: 968.92, taskAttribution: 'official-api', taskOfficialUpdatedAt: '2026-11-08T08:00:00Z',
      taskByModel: { Sonus: { total: 968.92 } }, conversationCredits: 1000, status: 'completed',
      ledgerReconciliation: { unmatchedCredits: 53.21 } }
  } };
  const result = run(`${updateHarness}
    $script:testState='${JSON.stringify(state)}' | ConvertFrom-Json
    $script:testViewedSessionId='${a}'
    & $update
    $online=@{chip=$chipValue.Text; label=$taskLabel.Text; calibration=$calibValue.Text; model=$modelValue.Text}
    $script:testState.officialSync.status='browser-closed'
    & $update
    @{online=$online; offline=$calibValue.Text; offlineChip=$chipValue.Text} | ConvertTo-Json -Compress
    $toast.Close()`);
  assert.equal(result.online.chip, '968.92');
  assert.match(result.online.label, /官网/);
  assert.doesNotMatch(result.online.calibration, /53\.21|未归属/);
  assert.match(result.online.model, /Sonus 968\.92/);
  assert.match(result.offline, /缓存/);
  assert.equal(result.offlineChip, '968.92');
});

test('a turn without official evidence is explicitly recorded-only even without a ledger residual', { skip: process.platform !== 'win32' }, () => {
  const state = { officialSync: { status: 'login-required' }, lastCompleted: null, sessions: {
    [a]: { taskCredits: 915.71, conversationCredits: 1000, status: 'completed', taskAttribution: 'transcript-only' }
  } };
  const result = run(`${updateHarness}
    $script:testState='${JSON.stringify(state)}' | ConvertFrom-Json
    $script:testViewedSessionId='${a}'
    & $update
    @{label=$taskLabel.Text; chipLabel=$chipLabel.Text; calibration=$calibValue.Text} | ConvertTo-Json -Compress
    $toast.Close()`);
  assert.match(result.label, /已记录/);
  assert.equal(result.chipLabel, '积分');
  assert.match(result.calibration, /登录/);
});

test('a running turn is labelled as still being recorded, not a final charge', { skip: process.platform !== 'win32' }, () => {
  const state = { officialSync: { status: 'synced' }, lastCompleted: null, sessions: {
    [a]: { taskCredits: 6.67, conversationCredits: 100, status: 'running', taskAttribution: 'transcript-only' }
  } };
  const result = run(`${updateHarness}
    $script:testState='${JSON.stringify(state)}' | ConvertFrom-Json
    $script:testViewedSessionId='${a}'
    & $update
    @{chip=$chipValue.Text; chipLabel=$chipLabel.Text; label=$taskLabel.Text} | ConvertTo-Json -Compress
    $toast.Close()`);
  assert.equal(result.chip, '6.67');
  assert.equal(result.chipLabel, '记录中');
  assert.match(result.label, /记录中/);
  assert.match(result.label, /待结清/);
  assert.doesNotMatch(result.label, /官网实扣/);
});

const updateState = {
  currentSessionId: b,
  lastCompleted: { sessionId: b, at: '2026-01-01T00:00:01Z', taskCredits: 2 },
  sessions: {
    [a]: { taskCredits: 90, conversationCredits: 100, status: 'completed' },
    [b]: { taskCredits: 2, conversationCredits: 7, status: 'completed' }
  }
};

test('the actual update queues a toast only for the viewed conversation', { skip: process.platform !== 'win32' }, () => {
  const result = run(`${updateHarness}
    $script:testState='${JSON.stringify(updateState)}' | ConvertFrom-Json
    $script:testViewedSessionId='${a}'
    & $update
    $script:testState.lastCompleted.at='2026-01-01T00:00:02Z'
    & $update
    $foreign=@{pending=$script:toastPending; chip=$chipValue.Text}
    $script:testState.lastCompleted.sessionId='${a}'
    $script:testState.lastCompleted.taskCredits=90
    $script:testState.lastCompleted.at='2026-01-01T00:00:03Z'
    & $update
    @{foreign=$foreign; ownPending=$script:toastPending; ownToast=$toastTask.Text} | ConvertTo-Json -Compress
    $toast.Close()`);
  assert.deepEqual(result.foreign, { pending: false, chip: '90.00' });
  assert.equal(result.ownPending, true);
  assert.match(result.ownToast, /90\.00 Credits$/);
  assert.match(result.ownToast, /已记录/);
});

test('switching to an unknown view clears displayed charges and a pending toast', { skip: process.platform !== 'win32' }, () => {
  const result = run(`${updateHarness}
    $script:testState='${JSON.stringify(updateState)}' | ConvertFrom-Json
    $script:testViewedSessionId='${b}'
    & $update
    $script:testState.lastCompleted.at='2026-01-01T00:00:02Z'
    & $update
    $wasPending=$script:toastPending
    $toastTimer.Start()
    $script:testViewedSessionId=$null
    & $update
    @{wasPending=$wasPending; pending=$script:toastPending; timer=$toastTimer.IsEnabled; chip=$chipValue.Text; task=$taskValue.Text; conversation=$convValue.Text} | ConvertTo-Json -Compress
    $toast.Close()`);
  assert.deepEqual(result, { wasPending: true, pending: false, timer: false, chip: '--', task: '--', conversation: '--' });
});
