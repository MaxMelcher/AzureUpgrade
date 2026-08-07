#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Selected')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Selected')]
    [ValidateNotNullOrEmpty()]
    [string[]] $Regions,

    [Parameter(Mandatory, ParameterSetName = 'All')]
    [switch] $AllRegions,

    [ValidatePattern('^[A-Z]{3}$')]
    [string] $CurrencyCode = 'GBP',

    [string] $OutputPath = (Join-Path $PSScriptRoot '..\src\assets\data')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:RegionAmbiguities = 0

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]] $Arguments)

    $errorFile = [IO.Path]::GetTempFileName()
    try {
        $json = (& az @Arguments --only-show-errors --output json 2>$errorFile | Out-String)
        if ($LASTEXITCODE -ne 0) {
            $message = [IO.File]::ReadAllText($errorFile)
            throw "Azure CLI failed: $message"
        }
        return $json | ConvertFrom-Json -Depth 100
    }
    finally {
        Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-RetailPriceRequest {
    param([Parameter(Mandatory)][string] $Uri)

    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 120
        }
        catch {
            if ($attempt -eq 5) { throw }
            $delay = [Math]::Pow(2, $attempt)
            Write-Warning "Retail Prices request failed (attempt $attempt/5). Retrying in $delay seconds."
            Start-Sleep -Seconds $delay
        }
    }
}

function Get-CapabilityValue {
    param(
        [Parameter(Mandatory)] $Sku,
        [Parameter(Mandatory)][string] $Name
    )

    $capability = $Sku.capabilities | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if ($null -eq $capability) { return $null }
    return [string] $capability.value
}

function Convert-ToNullableDouble {
    param([AllowNull()][string] $Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $parsed = 0.0
    if ([double]::TryParse($Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref] $parsed)) {
        return $parsed
    }
    return $null
}

function Convert-ToNullableInt {
    param([AllowNull()][string] $Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $parsed = 0
    if ([int]::TryParse($Value, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref] $parsed)) {
        return $parsed
    }
    return $null
}

function Convert-ToNullableBoolean {
    param([AllowNull()][string] $Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    if ($Value -match '^(?i:true)$') { return $true }
    if ($Value -match '^(?i:false)$') { return $false }
    return $null
}

function Write-DeterministicJson {
    param(
        [Parameter(Mandatory)] $Value,
        [Parameter(Mandatory)][string] $Path
    )

    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporaryPath = Join-Path $directory (".{0}.{1}.tmp" -f ([IO.Path]::GetFileName($Path)), [guid]::NewGuid())
    $json = ConvertTo-Json -InputObject $Value -Depth 30 -Compress
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Get-RetailPrices {
    param(
        [Parameter(Mandatory)][string] $Region,
        [Parameter(Mandatory)][string] $Currency
    )

    $filter = "serviceName eq 'Virtual Machines' and armRegionName eq '$Region'"
    $uri = 'https://prices.azure.com/api/retail/prices?currencyCode={0}&$filter={1}' -f $Currency, [uri]::EscapeDataString($filter)
    $items = [Collections.Generic.List[object]]::new()
    $page = 0
    while (-not [string]::IsNullOrWhiteSpace($uri)) {
        $page++
        Write-Host "    pricing page $page"
        $response = Invoke-RetailPriceRequest -Uri $uri
        foreach ($item in $response.Items) { $items.Add($item) }
        $uri = [string] $response.NextPageLink
    }
    return $items
}

function Get-OperatingSystem {
    param($Price)
    $description = "$($Price.productName) $($Price.skuName) $($Price.meterName)"
    if ($description -match '(?i)\bwindows\b') { return 'windows' }
    return 'linux'
}

function Test-IsExcludedPrice {
    param($Price)
    $description = "$($Price.productName) $($Price.skuName) $($Price.meterName)"
    return $description -match '(?i)\bspot\b|\blow priority\b|\bdev/?test\b'
}

function Select-DeterministicPrice {
    param(
        [object[]] $Entries,
        [string] $Label
    )

    if ($Entries.Count -eq 0) { return $null }
    $now = [datetime]::UtcNow
    $active = @($Entries | Where-Object {
        $null -eq $_.effectiveEndDate -or [datetime] $_.effectiveEndDate -gt $now
    })
    if ($active.Count -eq 0) { return $null }
    $sorted = @($active | Sort-Object `
        @{ Expression = { if ($_.effectiveStartDate) { [datetime] $_.effectiveStartDate } else { [datetime]::MinValue } }; Descending = $true }, `
        @{ Expression = { [double] $_.retailPrice }; Ascending = $true }, `
        @{ Expression = { [string] $_.meterId }; Ascending = $true })
    $latestDate = $sorted[0].effectiveStartDate
    $latest = @($sorted | Where-Object { $_.effectiveStartDate -eq $latestDate })
    $distinct = @($latest | ForEach-Object { [double] $_.retailPrice } | Sort-Object -Unique)
    if ($distinct.Count -gt 1) {
        $script:RegionAmbiguities++
        Write-Warning "Ambiguous $Label prices: $($distinct -join ', '). Deterministically selected $($sorted[0].retailPrice)."
    }
    return [double] $sorted[0].retailPrice
}

function New-PriceLookup {
    param([Collections.Generic.List[object]] $RetailPrices)

    $lookup = @{}
    $groups = $RetailPrices | Where-Object { -not [string]::IsNullOrWhiteSpace($_.armSkuName) } | Group-Object armSkuName
    foreach ($group in $groups) {
        $record = [ordered] @{
            linuxPaygHourly = $null
            windowsPaygHourly = $null
            linuxReservation1Year = $null
            linuxReservation3Year = $null
            windowsReservation1Year = $null
            windowsReservation3Year = $null
        }

        foreach ($os in @('linux', 'windows')) {
            $payg = @($group.Group | Where-Object {
                $_.type -eq 'Consumption' -and
                $_.isPrimaryMeterRegion -eq $true -and
                $_.unitOfMeasure -eq '1 Hour' -and
                (Get-OperatingSystem $_) -eq $os -and
                -not (Test-IsExcludedPrice $_)
            })
            $record["${os}PaygHourly"] = Select-DeterministicPrice -Entries $payg -Label "$($group.Name) $os PAYG"

            foreach ($term in @('1 Year', '3 Years')) {
                $reservation = @($group.Group | Where-Object {
                    $_.type -eq 'Reservation' -and
                    $_.reservationTerm -eq $term -and
                    (Get-OperatingSystem $_) -eq $os -and
                    -not (Test-IsExcludedPrice $_)
                })
                $termPrice = Select-DeterministicPrice -Entries $reservation -Label "$($group.Name) $os $term reservation"
                if ($null -ne $termPrice) {
                    $hours = if ($term -eq '1 Year') { 8760 } else { 26280 }
                    $suffix = if ($term -eq '1 Year') { '1Year' } else { '3Year' }
                    $record["${os}Reservation$suffix"] = [Math]::Round($termPrice / $hours, 10)
                }
            }
        }
        $lookup[$group.Name.ToLowerInvariant()] = $record
    }
    return $lookup
}

function Convert-Sku {
    param(
        [Parameter(Mandatory)] $Sku,
        [Parameter(Mandatory)][string] $Region,
        [Parameter(Mandatory)][hashtable] $PriceLookup,
        [Parameter(Mandatory)] $CpuLookup
    )

    $vcpus = Convert-ToNullableInt (Get-CapabilityValue $Sku 'vCPUs')
    $vcpusAvailable = Convert-ToNullableInt (Get-CapabilityValue $Sku 'vCPUsAvailable')
    if ($null -eq $vcpusAvailable) { $vcpusAvailable = $vcpus }
    $azureArchitecture = Get-CapabilityValue $Sku 'CpuArchitectureType'
    $cpu = if ($CpuLookup.ContainsKey([string] $Sku.family)) { $CpuLookup[[string] $Sku.family] } else { $null }
    $architecture = if (-not [string]::IsNullOrWhiteSpace($azureArchitecture)) {
        $azureArchitecture
    } elseif ($null -ne $cpu) {
        [string] $cpu.architecture
    } else {
        $null
    }

    $locationInfo = $Sku.locationInfo | Where-Object { $_.location -eq $Region } | Select-Object -First 1
    $zones = @($locationInfo.zones | Where-Object { $_ } | Sort-Object -Unique)
    $restrictions = @($Sku.restrictions | ForEach-Object {
        $values = @(
            $_.restrictionInfo.locations
            $_.restrictionInfo.zones
        ) | Where-Object { $_ } | Sort-Object -Unique
        [ordered] @{
            type = [string] $_.type
            reasonCode = if ($_.reasonCode) { [string] $_.reasonCode } else { $null }
            values = @($values)
        }
    })
    $priceKey = ([string] $Sku.name).ToLowerInvariant()
    $prices = if ($PriceLookup.ContainsKey($priceKey)) {
        $PriceLookup[$priceKey]
    } else {
        [ordered] @{
            linuxPaygHourly = $null
            windowsPaygHourly = $null
            linuxReservation1Year = $null
            linuxReservation3Year = $null
            windowsReservation1Year = $null
            windowsReservation3Year = $null
        }
    }

    $hyperV = Get-CapabilityValue $Sku 'HyperVGenerations'
    return [ordered] @{
        name = [string] $Sku.name
        family = [string] $Sku.family
        region = $Region
        tier = [string] $Sku.tier
        vcpus = $vcpus
        vcpusAvailable = $vcpusAvailable
        memoryGB = Convert-ToNullableDouble (Get-CapabilityValue $Sku 'MemoryGB')
        tempDiskMB = Convert-ToNullableInt (Get-CapabilityValue $Sku 'MaxResourceVolumeMB')
        maxDataDisks = Convert-ToNullableInt (Get-CapabilityValue $Sku 'MaxDataDiskCount')
        maxNICs = Convert-ToNullableInt (Get-CapabilityValue $Sku 'MaxNetworkInterfaces')
        premiumIO = Convert-ToNullableBoolean (Get-CapabilityValue $Sku 'PremiumIO')
        acceleratedNetworking = Convert-ToNullableBoolean (Get-CapabilityValue $Sku 'AcceleratedNetworkingEnabled')
        ephemeralOSDisk = Convert-ToNullableBoolean (Get-CapabilityValue $Sku 'EphemeralOSDiskSupported')
        rdma = Convert-ToNullableBoolean (Get-CapabilityValue $Sku 'RdmaEnabled')
        architecture = $architecture
        hyperVGenerations = if ($hyperV) { @($hyperV -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }
        cpuVendor = if ($null -ne $cpu) { [string] $cpu.vendor } else { $null }
        cpuGeneration = if ($null -ne $cpu -and $null -ne $cpu.generation) { [int] $cpu.generation } else { $null }
        zones = $zones
        restrictions = $restrictions
        prices = $prices
    }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI was not found. Install it from https://aka.ms/installazurecliwindows.'
}

try {
    $null = Invoke-AzJson -Arguments @('account', 'show')
}
catch {
    throw 'Azure CLI is not authenticated. Run az login before generating the catalog.'
}

$allLocations = @(Invoke-AzJson -Arguments @('account', 'list-locations'))
$physicalLocations = @($allLocations | Where-Object {
    -not $_.metadata.regionType -or $_.metadata.regionType -eq 'Physical'
})

if ($AllRegions) {
    $selectedRegions = @($physicalLocations | Select-Object -ExpandProperty name | Sort-Object -Unique)
} else {
    $selectedRegions = @($Regions | ForEach-Object { $_.Split(',') } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Sort-Object -Unique)
}

if ($selectedRegions.Count -eq 0) { throw 'No Azure regions were selected.' }

$knownRegions = @{}
foreach ($location in $allLocations) { $knownRegions[[string] $location.name] = [string] $location.displayName }
foreach ($region in $selectedRegions) {
    if (-not $knownRegions.ContainsKey($region)) { throw "Unknown Azure region '$region'." }
}

$cpuPath = Join-Path $OutputPath 'cpu-families.json'
if (-not (Test-Path -LiteralPath $cpuPath)) {
    throw "CPU metadata file not found: $cpuPath"
}
$cpuRaw = Get-Content -LiteralPath $cpuPath -Raw | ConvertFrom-Json
$cpuLookup = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($property in $cpuRaw.PSObject.Properties) { $cpuLookup[$property.Name] = $property.Value }

$regionOutputPath = Join-Path $OutputPath 'regions'
[IO.Directory]::CreateDirectory($regionOutputPath) | Out-Null
$regionIndex = [Collections.Generic.List[object]]::new()
$generatedAt = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')

for ($index = 0; $index -lt $selectedRegions.Count; $index++) {
    $region = $selectedRegions[$index]
    $displayName = $knownRegions[$region]
    Write-Progress -Activity 'Generating Azure VM catalog' -Status "$displayName ($($index + 1)/$($selectedRegions.Count))" -PercentComplete ((($index + 1) / $selectedRegions.Count) * 100)
    Write-Host "[$($index + 1)/$($selectedRegions.Count)] $displayName"
    $script:RegionAmbiguities = 0

    Write-Host '  Downloading VM SKU capabilities...'
    $rawSkus = @(Invoke-AzJson -Arguments @(
        'vm', 'list-skus',
        '--location', $region,
        '--resource-type', 'virtualMachines',
        '--all'
    ))
    $rawSkus = @($rawSkus | Where-Object {
        $_.resourceType -eq 'virtualMachines' -and $_.locations -contains $region
    } | Sort-Object name)

    Write-Host '  Downloading Azure Retail Prices...'
    $retailPrices = Get-RetailPrices -Region $region -Currency $CurrencyCode
    $priceLookup = New-PriceLookup -RetailPrices $retailPrices

    Write-Host '  Normalizing catalog...'
    $normalized = @($rawSkus | ForEach-Object {
        Convert-Sku -Sku $_ -Region $region -PriceLookup $priceLookup -CpuLookup $cpuLookup
    })

    $catalog = [ordered] @{
        schemaVersion = 1
        generatedAt = $generatedAt
        currencyCode = $CurrencyCode
        region = $region
        displayName = $displayName
        skus = $normalized
    }
    Write-DeterministicJson -Value $catalog -Path (Join-Path $regionOutputPath "$region.json")

    $linuxCount = @($normalized | Where-Object { $null -ne $_.prices.linuxPaygHourly }).Count
    $windowsCount = @($normalized | Where-Object { $null -ne $_.prices.windowsPaygHourly }).Count
    $cpuCount = @($normalized | Where-Object { $null -ne $_.cpuVendor -and $null -ne $_.cpuGeneration }).Count
    Write-Host "  $($normalized.Count) VM SKUs"
    Write-Host "  $linuxCount with Linux price"
    Write-Host "  $windowsCount with Windows price"
    Write-Host "  $cpuCount with complete CPU metadata"
    Write-Host "  $script:RegionAmbiguities pricing ambiguities"

    $regionIndex.Add([ordered] @{
        name = $region
        displayName = $displayName
        skuCount = $normalized.Count
    })
}

$regionIndex = @($regionIndex | Sort-Object displayName)
Write-DeterministicJson -Value $regionIndex -Path (Join-Path $OutputPath 'regions.json')

$selectedFileNames = @($selectedRegions | ForEach-Object { "$_.json" })
Get-ChildItem -LiteralPath $regionOutputPath -Filter '*.json' -File | Where-Object {
    $_.Name -notin $selectedFileNames
} | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
}

Write-Progress -Activity 'Generating Azure VM catalog' -Completed
Write-Host "Catalog generated in $([IO.Path]::GetFullPath($OutputPath))."
