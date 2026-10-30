import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script=fileURLToPath(new URL('../overlay/overlay.ps1',import.meta.url));
test('native ownership follows Qoder, all panels are non-topmost, and moving preserves z-order', () => {
 const code=`
 $ErrorActionPreference='Stop'
 Add-Type -AssemblyName PresentationFramework
 $tokens=$null; $errors=$null
 $ast=[System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
 if($errors.Count){throw ($errors | Out-String)}
 $native=$ast.Find({param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.Contains('public class QoderWin32')},$true)
 Add-Type -TypeDefinition $native.Value
 Add-Type 'using System; using System.Runtime.InteropServices; public class ZOrderProbe { [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd); }'
 foreach($name in @('Brush','New-Panel','Bind-QoderOwner','Move-Panel')) {
   $found=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
   if(-not $found){throw ('Missing function '+$name)}
   Invoke-Expression $found.Extent.Text
 }
 $owner=New-Object System.Windows.Window
 $owner.ShowActivated=$false; $owner.ShowInTaskbar=$false; $owner.Left=-5000; $owner.Top=-5000
 $hostHwnd=(New-Object System.Windows.Interop.WindowInteropHelper($owner)).EnsureHandle()
 $chip=(New-Panel)[0]; $window=(New-Panel)[0]; $toast=(New-Panel)[0]
 foreach($panel in @($chip,$window,$toast)){(New-Object System.Windows.Interop.WindowInteropHelper($panel)).EnsureHandle() | Out-Null}
 $script:ownerHwnd=[IntPtr]::Zero
 try {
   Bind-QoderOwner $hostHwnd
   foreach($panel in @($chip,$window,$toast)) {
     $helper=New-Object System.Windows.Interop.WindowInteropHelper($panel)
     $handle=$helper.EnsureHandle()
     if($helper.Owner -ne $hostHwnd){throw 'Panel not bound to owner'}
     if(([QoderWin32]::GetWindowLong($handle,-20) -band 8) -ne 0){throw 'Panel still globally topmost'}
   }
   $owner.Show(); $chip.Show()
   $other=New-Object System.Windows.Window
   $other.ShowActivated=$false; $other.ShowInTaskbar=$false; $other.Left=-5000; $other.Top=-5000
   try {
     $other.Show()
     $handle=(New-Object System.Windows.Interop.WindowInteropHelper($chip)).Handle
     $above=[ZOrderProbe]::GetWindow($handle,3)
     Move-Panel $handle -4900 -4900
     if([ZOrderProbe]::GetWindow($handle,3) -ne $above){throw 'Moving promoted overlay in z-order'}
   } finally {$other.Close()}
   'ownership and z-order OK'
 } finally { foreach($panel in @($toast,$window,$chip,$owner)){$panel.Close()} }
 `;
 const r=spawnSync('powershell.exe',['-STA','-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true});
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(r.stdout,/ownership and z-order OK/);
});

test('task amounts use plain numbers and compact product copy', () => {
 const text=fs.readFileSync(script,'utf8');
 assert.ok(!text.includes('≥'));
 assert.ok(!text.includes('待结清'));
 assert.match(text,/\$taskLabel\.Text = '本轮消耗'/);
 assert.match(text,/本轮消耗 \{0:F2\} Credits/);
});
