# CloudDrive RC9: guarded disaster-recovery to ISOLATED resources only.
# Without -Apply this script is a non-mutating validation / plan.
param(
  [Parameter(Mandatory=$true)][string]$BackupDirectory,
  [string]$R2Remote = '',
  [string]$NewDatabase = '',
  [string]$NewPrivateBucket = '',
  [string]$NewPublicBucket = '',
  [switch]$Apply,
  [string]$Confirm = ''
)
$ErrorActionPreference = 'Stop'
$dir = (Resolve-Path -LiteralPath $BackupDirectory).Path
$manifestFile = Join-Path $dir 'manifest.json'
$sql = Join-Path $dir 'database.sql'
if (-not (Test-Path $manifestFile) -or -not (Test-Path $sql)) { throw '缺少 manifest.json 或 database.sql。' }
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if ($manifest.format -ne 'RC9-production-backup-v1') { throw '备份版本标识不匹配。' }
$hash = (Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash
if ($hash -ne $manifest.sql_sha256) { throw 'SQL SHA256 校验失败，停止恢复。' }
Write-Host ('[CloudDrive] 备份类型: {0}' -f $manifest.backup_type)
Write-Host ('[CloudDrive] SQL 校验通过，文件: {0}' -f $sql)
if ($manifest.backup_type -ne 'd1_and_r2') { Write-Warning '备份不包含 R2 文件，无法完整恢复网盘。' }
if (-not $Apply) {
 Write-Host '[CloudDrive] 只读恢复计划：创建独立 D1 数据库和独立的两个 R2 桶，导入 SQL，然后复制备份对象。'
 Write-Host '参数示例: -NewDatabase clouddrive-restore -NewPrivateBucket clouddrive-private-restore -NewPublicBucket clouddrive-public-restore -R2Remote r2 -Apply -Confirm ISOLATED-RESTORE'
 return
}
if ($Confirm -ne 'ISOLATED-RESTORE') { throw '需要显式 -Confirm ISOLATED-RESTORE 才能执行。' }
if ($manifest.backup_type -ne 'd1_and_r2') { throw '仅 D1 备份禁止以完整恢复模式执行。' }
if ($NewDatabase -notmatch '^[a-z0-9-]+$' -or $NewDatabase -eq 'clouddrive-db') { throw '必须使用全新的隔离 D1 数据库名，禁止覆盖生产 clouddrive-db。' }
foreach ($bucket in @($NewPrivateBucket,$NewPublicBucket)) {
 if ($bucket -notmatch '^[a-z0-9-]+$' -or $bucket -in @('clouddrive-private','clouddrive-public')) { throw '恢复桶必须有新名称，禁止覆盖生产桶。' }
}
if ($NewPrivateBucket -eq $NewPublicBucket) { throw '恢复桶不能同名。' }
if ($R2Remote -notmatch '^[a-zA-Z0-9_.-]+$') { throw 'R2Remote 格式不正确。' }
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) { throw '未安装 rclone。' }
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw '未安装 Node.js/npx。' }
# Existence and emptiness checks happen BEFORE changing any recovery resource.
foreach ($b in @($NewPrivateBucket,$NewPublicBucket)) {
 $remote = ('{0}:{1}' -f $R2Remote,$b)
 $items = @(& rclone lsf $remote --max-depth 1)
 if ($LASTEXITCODE -ne 0) { throw ('无法读取新建 R2 桶: ' + $b) }
 if ($items.Count -gt 0 -and ($items | Where-Object { $_ -ne '' }).Count -gt 0) { throw ('恢复目标 R2 桶非空，拒绝覆盖: ' + $b) }
}
# The destination D1 must contain no user tables: importing SQL into an
# existing database risks an accidental merge or schema collision.
$check = @(& npx wrangler d1 execute $NewDatabase --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1" --json)
if ($LASTEXITCODE -ne 0) { throw '无法确认隔离 D1 是否为空；已拒绝恢复。' }
try {
  $parsed = ($check | Out-String | ConvertFrom-Json)
  $rows = @($parsed | ForEach-Object { $_.results } | Where-Object { $null -ne $_ })
} catch { throw 'Wrangler D1 检查结果无法按 JSON 解析；已拒绝恢复。' }
if ($rows.Count -gt 0) { throw '隔离 D1 数据库不为空，拒绝导入。' }
Write-Warning '确认你已在 Cloudflare 创建了一个空的独立 D1 数据库及两个空的恢复桶。此操作不会修改生产 Worker 的绑定。'
# Export format from Wrangler can contain CREATE TABLE and INSERT; import only into an empty database.
& npx wrangler d1 execute $NewDatabase --remote --file $sql
if ($LASTEXITCODE -ne 0) { throw '隔离 D1 SQL 导入失败，请不要将生产 Worker 指向该数据库。' }
# Restore FROM LOCAL backups TO new R2 target buckets.
foreach ($pair in @(@('clouddrive-private',$NewPrivateBucket),@('clouddrive-public',$NewPublicBucket))) {
 $source = Join-Path $dir $pair[0]
 if (-not (Test-Path $source)) { throw ('备份缺少对象目录: ' + $source) }
 $target = ('{0}:{1}' -f $R2Remote,$pair[1])
 & rclone copy $source $target --transfers 2 --checkers 4 --retries 3
 if ($LASTEXITCODE -ne 0) { throw ('隔离 R2 恢复失败: ' + $pair[1]) }
 & rclone check $source $target --size-only --one-way
 if ($LASTEXITCODE -ne 0) { throw ('恢复后对象校验失败: ' + $pair[1]) }
}
Write-Host '[CloudDrive] 隔离恢复操作完成。仍需人工核对文件和 D1 对象映射；不得自动切换生产 Worker。'
