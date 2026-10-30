import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('PowerShell parses and the state reader allows delete-sharing replacement', () => {
 const script=fileURLToPath(new URL('../overlay/overlay.ps1',import.meta.url));
 const code=`$tokens=$null; $errors=$null; $ast=[System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'","''")}',[ref]$tokens,[ref]$errors); if($errors.Count){throw ($errors | Out-String)}; $f=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-SharedJson'},$true); if(-not $f){throw 'Missing shared reader'}; Invoke-Expression $f.Extent.Text; $dir=Join-Path $env:TEMP ('credits-share-'+[guid]::NewGuid()); [IO.Directory]::CreateDirectory($dir) | Out-Null; $p=Join-Path $dir 'state.json'; [IO.File]::WriteAllText($p,'{"n":1}'); if((Read-SharedJson $p).n -ne 1){throw 'Read failed'}; $handle=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); try { [IO.File]::WriteAllText((Join-Path $dir 'new.json'),'{"n":2}'); [IO.File]::Replace((Join-Path $dir 'new.json'),$p,$null); if((Read-SharedJson $p).n -ne 2){throw 'Replace failed'} } finally {$handle.Dispose()}; 'AST and sharing OK'`;
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true});
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/AST and sharing OK/);
});
