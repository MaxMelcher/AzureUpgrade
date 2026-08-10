#Requires -Version 7.0
[CmdletBinding()]
param(
    [string] $DataPath = (Join-Path $PSScriptRoot '..\src\assets\data'),

    [ValidateSet('USD', 'EUR', 'GBP')]
    [string[]] $CurrencyCode = @('USD', 'EUR', 'GBP')
)

$ErrorActionPreference = 'Stop'

function Write-DeterministicJson {
    param(
        [Parameter(Mandatory)] $Value,
        [Parameter(Mandatory)][string] $Path
    )

    $json = ConvertTo-Json -InputObject $Value -Depth 10 -Compress
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

function Convert-ToGeneratedAtString {
    param([Parameter(Mandatory)] $Value)
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return [string] $Value
}

$regionRoot = Join-Path $DataPath 'regions'
$currencies = @($CurrencyCode | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique)
$filesByCurrency = @{}

foreach ($currency in $currencies) {
    $currencyPath = Join-Path $regionRoot $currency
    if (-not (Test-Path -LiteralPath $currencyPath -PathType Container)) {
        throw "Merged catalog is missing the '$currency' directory."
    }
    $filesByCurrency[$currency] = @(Get-ChildItem -LiteralPath $currencyPath -Filter '*.json' -File | Sort-Object Name)
    if ($filesByCurrency[$currency].Count -eq 0) {
        throw "Merged catalog contains no '$currency' region files."
    }
}

$referenceCurrency = $currencies[0]
$referenceNames = @($filesByCurrency[$referenceCurrency] | Select-Object -ExpandProperty Name)
foreach ($currency in $currencies | Where-Object { $_ -ne $referenceCurrency }) {
    $currencyNames = @($filesByCurrency[$currency] | Select-Object -ExpandProperty Name)
    $difference = @(Compare-Object -ReferenceObject $referenceNames -DifferenceObject $currencyNames)
    if ($difference.Count -gt 0) {
        throw "Region files differ between '$referenceCurrency' and '$currency': $($difference.InputObject -join ', ')."
    }
}

$catalogsByCurrency = @{}
foreach ($currency in $currencies) {
    $catalogsByCurrency[$currency] = @{}
    foreach ($file in $filesByCurrency[$currency]) {
        $catalog = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string] $catalog.region) -or @($catalog.skus).Count -eq 0) {
            throw "Invalid or empty regional catalog: $($file.FullName)"
        }
        if ("$($catalog.region).json" -ne $file.Name) {
            throw "Catalog region '$($catalog.region)' does not match file '$($file.Name)'."
        }
        if ([string] $catalog.currencyCode -ne $currency.ToUpperInvariant()) {
            throw "Catalog '$($file.FullName)' has currency '$($catalog.currencyCode)', expected '$($currency.ToUpperInvariant())'."
        }
        $catalogsByCurrency[$currency][$file.Name] = $catalog
    }
}

foreach ($fileName in $referenceNames) {
    $expectedSkuCount = @($catalogsByCurrency[$referenceCurrency][$fileName].skus).Count
    foreach ($currency in $currencies | Where-Object { $_ -ne $referenceCurrency }) {
        $actualSkuCount = @($catalogsByCurrency[$currency][$fileName].skus).Count
        if ($actualSkuCount -ne $expectedSkuCount) {
            throw "SKU count differs for '$fileName': $referenceCurrency=$expectedSkuCount, $currency=$actualSkuCount."
        }
    }
}

$regionIndex = @($filesByCurrency[$referenceCurrency] | ForEach-Object {
    $catalog = $catalogsByCurrency[$referenceCurrency][$_.Name]
    [ordered] @{
        name = [string] $catalog.region
        displayName = [string] $catalog.displayName
        skuCount = @($catalog.skus).Count
        generatedAt = Convert-ToGeneratedAtString $catalog.generatedAt
    }
} | Sort-Object displayName, name)

Write-DeterministicJson -Value $regionIndex -Path (Join-Path $DataPath 'regions.json')
Write-Host "Validated $($regionIndex.Count) regions across $($currencies.Count) currencies and rebuilt regions.json."
