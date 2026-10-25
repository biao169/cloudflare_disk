# CloudDrive RC9 - Windows manual/Task Scheduler backup.
# Produces a genuine D1 SQL export and optionally copies BOTH R2 buckets.
# Requires a local Wrangler login and an independently configured rclone R2 remote.
param(
  [string]$Destination = 'backups',
  [string]$R2Remote = '',
  [switch]$D1Only
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $project
if (-not $D1Only -and $R2Remote -notmatch '^[a-zA-Z0-9_.-]+$') {
  throw '完整备份必须传入 -R2Remote r2；先通过 rclone config 创建 Cloudflare R2 远程连接。'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要 Node.js 与已安装的 Wrangler。' }
if (-not $D1Only -and -not (Get-Command rclone -ErrorAction SilentlyContinue)) { throw '需要先安装 rclone 并配置 R2 远程连接。' }
if (-not (Test-Path (Join-Path $project 'node_modules/wrangler'))) { throw '先在项目目录执行 npm install。' }
$started = Get-Date
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$base = if ([System.IO.Path]::IsPathRooted($Destination)) { $Destination } else { Join-Path $project $Destination }
$folder = Join-Path $base ('clouddrive-' + $stamp)
if (Test-Path -LiteralPath $folder) { throw '此时间戳的备份目录已存在，拒绝覆盖；请稍后重新启动备份。' }
New-Item -ItemType Directory -Path $folder | Out-Null
Write-Host '[CloudDrive] 开始 D1 SQL 导出（不会修改线上数据）'
& node (Join-Path $project 'scripts/deploy-cloudflare.mjs') --backup-only
if ($LASTEXITCODE -ne 0) { throw '远程 D1 导出失败；备份不完整。' }
$exports = @(Get-ChildItem -Path (Join-Path $project 'backups') -Filter 'clouddrive-d1-*.sql' -File |
  Where-Object { $_.LastWriteTime -ge $started.AddMinutes(-1) } | Sort-Object LastWriteTime -Descending)
if ($exports.Count -eq 0) { throw '未找到这次执行生成的 D1 SQL 导出文件。' }
$sql = Join-Path $folder 'database.sql'
Copy-Item -LiteralPath $exports[0].FullName -Destination $sql
if ((Get-Item $sql).Length -le 0) { throw 'D1 导出文件为空。' }
$bucketResults = @()
if (-not $D1Only) {
  foreach ($bucket in @('clouddrive-private','clouddrive-public')) {
    $target = Join-Path $folder $bucket
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $source = ('{0}:{1}' -f $R2Remote,$bucket)
    Write-Host ('[CloudDrive] 复制 R2 {0} 到本地（无删除操作）' -f $bucket)
    & rclone copy $source $target --transfers 2 --checkers 4 --retries 3
    if ($LASTEXITCODE -ne 0) { throw ('R2 下载失败: ' + $bucket + '；请勿将本次备份视为完成。') }
    & rclone check $source $target --size-only --one-way
    if ($LASTEXITCODE -ne 0) { throw ('R2 大小/清单核对失败: ' + $bucket) }
    $objects = @(Get-ChildItem -LiteralPath $target -Recurse -File)
    $sum = ($objects | Measure-Object Length -Sum).Sum
    $bucketResults += @{bucket=$bucket;files=$objects.Count;bytes=[int64]($sum -as [double]);verified_by='rclone size-only; not cryptographic'}
  }
}
$hash = (Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash
$manifest = @{
  product='CloudDrive'; format='RC9-production-backup-v1'
  created_utc=(Get-Date).ToUniversalTime().ToString('o')
  backup_type=$(if ($D1Only) { 'd1_only' } else { 'd1_and_r2' })
  sql_filename='database.sql'; sql_sha256=$hash
  d1_database='clouddrive-db'; r2=$bucketResults
  notes='R2 recovery must use an isolated bucket. D1 Time Travel cannot restore R2 files. Keep this folder secure.'
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $folder 'manifest.json') -Encoding UTF8
Write-Host ('[CloudDrive] 已导出到: {0}' -f $folder)
if ($D1Only) { Write-Warning '本次仅备份 D1，不包含 R2 文件，不能单独完成网盘恢复。' }
Write-Warning '备份可能包含私有文件、账号密码哈希和分享元数据。建议加密存放，并定期执行隔离恢复演练。'
