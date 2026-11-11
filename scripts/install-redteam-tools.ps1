#requires -Version 5.1
<#
  install-redteam-tools.ps1
  下载并安装红队工具箱里被插件引用的 CLI 二进制（Windows amd64 构建）到
  $env:DSH_HOME\redteam\toolkit\bin，并把该目录加入用户 PATH。
  版本锁定为 2026-11 上游最新；改版本只改下面的 $Pins。
  用法： pwsh -File scripts/install-redteam-tools.ps1 [-Only subfinder,naabu]
#>
param(
  [string[]]$Only = @('fscan','subfinder','naabu','nuclei'),
  [switch]$SkipTemplates
)

$ErrorActionPreference = 'Stop'
$bin = Join-Path $env:DSH_HOME 'redteam\toolkit\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$tmp = Join-Path $env:TEMP ("rt-tools-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# 版本锁（上游 release）
$Pins = @{
  fscan     = @{ ver='2.2.2';  kind='exe'; url='https://github.com/shadow1ng/fscan/releases/download/v2.2.2/fscan_2.2.2_windows_x64.exe' }
  subfinder = @{ ver='2.17.0'; kind='zip'; url='https://github.com/projectdiscovery/subfinder/releases/download/v2.17.0/subfinder_2.17.0_windows_amd64.zip' }
  naabu     = @{ ver='2.7.0';  kind='zip'; url='https://github.com/projectdiscovery/naabu/releases/download/v2.7.0/naabu_2.7.0_windows_amd64.zip' }
  nuclei    = @{ ver='3.11.1'; kind='zip'; url='https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_windows_amd64.zip' }
}

function Get-One($name) {
  $p = $Pins[$name]
  if (-not $p) { Write-Host "[skip] $name (no pin)"; return }
  $zip = Join-Path $tmp "$name.dl"
  Write-Host "[get ] $name v$($p.ver) <- $($p.url)"
  Invoke-WebRequest -Uri $p.url -OutFile $zip -UseBasicParsing
  if ($p.kind -eq 'exe') {
    $dest = Join-Path $bin ($name + '.exe')
    Copy-Item $zip $dest -Force
    Write-Host "[ ok ] -> $dest"
    return
  }
  $out = Join-Path $tmp $name
  Move-Item $zip ($zip = Join-Path $tmp "$name.zip") -Force
  Expand-Archive -Path $zip -DestinationPath $out -Force
  # 找到 exe 并复制到 bin
  $exes = Get-ChildItem $out -Recurse -Include *.exe -File
  if (-not $exes) { throw "${name}: zip 内没有 exe" }
  foreach ($e in $exes) {
    $dest = Join-Path $bin $e.Name
    Copy-Item $e.FullName $dest -Force
    Write-Host "[ ok ] -> $dest"
  }
}

foreach ($n in $Only) { Get-One $n }

# 让 nuclei 拉最新模板（模板版本单独演进）
if (-not $SkipTemplates -and ($Only -contains 'nuclei')) {
  $nuclei = Join-Path $bin 'nuclei.exe'
  if (Test-Path $nuclei) {
    Write-Host '[tmpl] nuclei -update-templates'
    try { & $nuclei -update-templates 2>&1 | Select-Object -Last 5 } catch { Write-Host "[tmpl] failed: $($_.Exception.Message)" }
  }
}

# 加入用户 PATH（幂等）
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
if ($userPath -notlike "*$bin*") {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
  Write-Host "[path] added $bin to user PATH (new shells only)"
} else { Write-Host "[path] already contains $bin" }

Write-Host '=== versions ==='
foreach ($t in @('fscan','subfinder','naabu','nuclei')) {
  $exe = Join-Path $bin "$t.exe"
  if (Test-Path $exe) {
    try {
      if ($t -eq 'fscan') { & $exe -h 2>&1 | Select-Object -First 1 }
      else { & $exe -version 2>&1 | Select-Object -First 1 }
    } catch { Write-Host "[$t] run failed: $($_.Exception.Message)" }
  } else { Write-Host "[$t] MISSING" }
}
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'DONE'
