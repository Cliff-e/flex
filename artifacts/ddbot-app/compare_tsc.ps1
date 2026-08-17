$ErrorActionPreference = 'Stop'
function Normalize($path) {
    Get-Content $path | ForEach-Object {
        ($_ -replace '\(\d+,\d+\)', '(*,*)').Trim()
    } | Where-Object { $_ -match 'error TS' } | Sort-Object
}
$base = Normalize 'baseline_tsc_output.txt'
$new  = Normalize 'new_tsc_output.txt'
Write-Output "BASELINE_DIAGNOSTICS=$($base.Count)"
Write-Output "NEW_DIAGNOSTICS=$($new.Count)"
$added = Compare-Object $base $new | Where-Object { $_.SideIndicator -eq '=>' } | Select-Object -ExpandProperty InputObject
$removed = Compare-Object $base $new | Where-Object { $_.SideIndicator -eq '<=' } | Select-Object -ExpandProperty InputObject
Write-Output "=== ONLY-IN-NEW (candidate regressions): $($added.Count) ==="
$added | ForEach-Object { Write-Output "  + $_" }
Write-Output "=== ONLY-IN-BASELINE (fixed/changed): $($removed.Count) ==="
$removed | ForEach-Object { Write-Output "  - $_" }
