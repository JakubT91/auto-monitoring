Set-Location $PSScriptRoot
Write-Host "=== Diagnostika notifier.js ===" -ForegroundColor Cyan
$file = "src\notifier.js"
$content = Get-Content $file -Raw

if ($content -match "Math\.abs\(daysLeft - days\)") {
    Write-Host "✓ Math.abs už je v kódu" -ForegroundColor Green
} elseif ($content -match "daysLeft === days") {
    Write-Host "→ Měním daysLeft === days na Math.abs..." -ForegroundColor Yellow
    $content = $content -replace [regex]::Escape("if (daysLeft === days) {"), "if (Math.abs(daysLeft - days) <= 1) {"
    Set-Content $file $content -NoNewline -Encoding UTF8
    Write-Host "✓ Upraveno" -ForegroundColor Green
} else {
    Write-Host "⚠ Neznámá verze. Vypíšu řádky kolem daysLeft:" -ForegroundColor Red
    Select-String -Path $file -Pattern "daysLeft" -Context 1,1
}

Write-Host ""
Write-Host "=== Deploy Workeru ===" -ForegroundColor Cyan
npx wrangler deploy

Write-Host ""
Write-Host "=== Test Workeru ===" -ForegroundColor Cyan
$url = "https://auto-monitoring-notifications.jakubtichy91.workers.dev/run?key=auto-monitoring-test-2026-XYZ-789"
Start-Sleep -Seconds 3
try {
    $response = Invoke-RestMethod -Uri $url -Method Get
    Write-Host "JSON response:" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 10
    Write-Host ""
    if ($response.notifications_due -gt 0) {
        Write-Host "🎉 ÚSPĚCH! Mělo by ti přijít $($response.emails_sent) mailů. Mrkni do schránky (i spam)!" -ForegroundColor Green
    } else {
        Write-Host "⚠ Ještě 0 notifikací. Zkontroluj stav dokladů v aplikaci." -ForegroundColor Yellow
    }
} catch {
    Write-Host "Chyba: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Hotovo. Stiskni ENTER pro zavření ===" -ForegroundColor Cyan
Read-Host
