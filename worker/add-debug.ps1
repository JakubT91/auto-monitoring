Set-Location $PSScriptRoot

$file = "src\notifier.js"
$content = Get-Content $file -Raw

# Najdi řádek, kde se spočítá daysLeft a přidej console.log za něj
$marker = "if (Math.abs(daysLeft - days) <= 1) {"

if ($content -notmatch [regex]::Escape("DEBUG_LOG_DAYSLEFT")) {
    $debugLog = @"
        // DEBUG_LOG_DAYSLEFT
        console.log(JSON.stringify({ debug: 'doc-check', vehicle: v?.name, type: docType, expiry: expiryDate, daysLeft, threshold: days, match: Math.abs(daysLeft - days) <= 1 }));
        $marker
"@
    $content = $content -replace [regex]::Escape($marker), $debugLog

    # Přidej i log po načtení vehicles
    $vehiclesMarker = "for (const v of vehicles) {"
    $vehiclesLog = @"
      console.log(JSON.stringify({ debug: 'vehicles-loaded', count: vehicles.length, names: vehicles.map(x => x.name) }));
      $vehiclesMarker
"@
    $content = $content -replace [regex]::Escape($vehiclesMarker), $vehiclesLog

    Set-Content $file $content -NoNewline -Encoding UTF8
    Write-Host "✓ Debug logy přidány do notifier.js" -ForegroundColor Green
} else {
    Write-Host "✓ Debug logy už jsou v kódu" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Deploy ===" -ForegroundColor Cyan
npx wrangler deploy

Write-Host ""
Write-Host "✅ Hotovo. TEĎ:" -ForegroundColor Green
Write-Host "  1. Spusť v jiném PowerShellu:  npx wrangler tail" -ForegroundColor Yellow
Write-Host "  2. Otevři v browseru URL s ?key=... — uvidíš debug výpis." -ForegroundColor Yellow
Read-Host "Stiskni ENTER"
