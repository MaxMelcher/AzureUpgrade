#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Selected')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Selected')]
    [ValidateNotNullOrEmpty()]
    [string[]] $Regions,

    [Parameter(Mandatory, ParameterSetName = 'All')]
    [switch] $AllRegions,

    [Parameter(ParameterSetName = 'All')]
    [ValidateRange(0, 63)]
    [int] $ShardIndex = 0,

    [Parameter(ParameterSetName = 'All')]
    [ValidateRange(1, 64)]
    [int] $ShardCount = 1,

    [ValidateSet('USD', 'EUR', 'GBP')]
    [string[]] $CurrencyCode = @('USD', 'EUR', 'GBP'),

    [string] $OutputPath = (Join-Path $PSScriptRoot '..\src\assets\data'),

    [string] $CpuMetadataPath = (Join-Path $OutputPath 'cpu-families.json')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:RegionAmbiguities = 0

# Azure CLI may need to refresh its access token during an all-region run, but the assertion cached
# by azure/login expires after a few minutes. Request a new assertion without storing a secret.
function Update-AzureCliGitHubOidcLogin {
    $requiredVariables = @(
        'ACTIONS_ID_TOKEN_REQUEST_URL'
        'ACTIONS_ID_TOKEN_REQUEST_TOKEN'
        'AZURE_CLIENT_ID'
        'AZURE_TENANT_ID'
        'AZURE_SUBSCRIPTION_ID'
    )
    $missingVariables = @($requiredVariables | Where-Object {
        [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
    })
    if ($missingVariables.Count -gt 0) {
        throw "Azure CLI authentication expired and cannot be renewed because these environment variables are missing: $($missingVariables -join ', ')."
    }

    Write-Host '  Azure CLI token expired; requesting a fresh GitHub OIDC assertion...'
    $audience = [uri]::EscapeDataString('api://AzureADTokenExchange')
    $requestUri = "$env:ACTIONS_ID_TOKEN_REQUEST_URL&audience=$audience"
    $response = Invoke-RestMethod -Uri $requestUri -Method Get -Headers @{
        Authorization = "Bearer $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN"
    } -TimeoutSec 30
    if ([string]::IsNullOrWhiteSpace([string] $response.value)) {
        throw 'GitHub returned an empty OIDC assertion.'
    }

    $errorFile = [IO.Path]::GetTempFileName()
    try {
        $null = & az login `
            --service-principal `
            --username $env:AZURE_CLIENT_ID `
            --tenant $env:AZURE_TENANT_ID `
            --federated-token $response.value `
            --only-show-errors `
            --output none 2>$errorFile
        if ($LASTEXITCODE -ne 0) {
            $message = [IO.File]::ReadAllText($errorFile)
            throw "Azure CLI OIDC renewal failed: $message"
        }

        $null = & az account set `
            --subscription $env:AZURE_SUBSCRIPTION_ID `
            --only-show-errors 2>$errorFile
        if ($LASTEXITCODE -ne 0) {
            $message = [IO.File]::ReadAllText($errorFile)
            throw "Azure CLI could not restore the configured subscription: $message"
        }
    }
    finally {
        Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]] $Arguments)

    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $errorFile = [IO.Path]::GetTempFileName()
        try {
            $json = (& az @Arguments --only-show-errors --output json 2>$errorFile | Out-String)
            if ($LASTEXITCODE -eq 0) {
                return $json | ConvertFrom-Json -Depth 100
            }

            $message = [IO.File]::ReadAllText($errorFile)
            if ($attempt -eq 1 -and $message -match 'AADSTS700024') {
                Update-AzureCliGitHubOidcLogin
                continue
            }
            throw "Azure CLI failed: $message"
        }
        finally {
            Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
        }
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

function Convert-ToGeneratedAtString {
    param([Parameter(Mandatory)] $Value)
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    return [string] $Value
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
                $_.unitOfMeasure -eq '1 Hour' -and
                (Get-OperatingSystem $_) -eq $os -and
                -not (Test-IsExcludedPrice $_)
            })
            $primaryPayg = @($payg | Where-Object { $_.isPrimaryMeterRegion -eq $true })
            $paygPrice = Select-DeterministicPrice -Entries $primaryPayg -Label "$($group.Name) $os PAYG"
            if ($null -eq $paygPrice) {
                # Some active legacy base meters are marked non-primary while only their Spot
                # meters are primary. Prefer primary meters, but do not discard valid PAYG prices.
                $paygPrice = Select-DeterministicPrice -Entries $payg -Label "$($group.Name) $os PAYG fallback"
            }
            $record["${os}PaygHourly"] = $paygPrice

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
        gpus = Convert-ToNullableInt (Get-CapabilityValue $Sku 'GPUs')
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
        cpuArchitecture = if ($null -ne $cpu) { [string] $cpu.architecture } else { $null }
        cpuModel = if ($null -ne $cpu) { [string] $cpu.model } else { $null }
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
    if ($ShardIndex -ge $ShardCount) {
        throw "ShardIndex ($ShardIndex) must be less than ShardCount ($ShardCount)."
    }
    if ($ShardCount -gt 1) {
        $selectedRegions = @(for ($regionIndex = 0; $regionIndex -lt $selectedRegions.Count; $regionIndex++) {
            if ($regionIndex % $ShardCount -eq $ShardIndex) { $selectedRegions[$regionIndex] }
        })
        Write-Host "Shard $($ShardIndex + 1)/$ShardCount selected $($selectedRegions.Count) regions."
    }
} else {
    $selectedRegions = @($Regions | ForEach-Object { $_.Split(',') } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Sort-Object -Unique)
}

if ($selectedRegions.Count -eq 0) { throw 'No Azure regions were selected.' }

$knownRegions = @{}
foreach ($location in $allLocations) { $knownRegions[[string] $location.name] = [string] $location.displayName }
foreach ($region in $selectedRegions) {
    if (-not $knownRegions.ContainsKey($region)) { throw "Unknown Azure region '$region'." }
}

if (-not (Test-Path -LiteralPath $CpuMetadataPath)) {
    throw "CPU metadata file not found: $CpuMetadataPath"
}
$cpuRaw = Get-Content -LiteralPath $CpuMetadataPath -Raw | ConvertFrom-Json
$cpuLookup = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($property in $cpuRaw.PSObject.Properties) { $cpuLookup[$property.Name] = $property.Value }

$currencyCodes = @($CurrencyCode | ForEach-Object { $_.ToUpperInvariant() } | Sort-Object -Unique)
$regionOutputRoot = Join-Path $OutputPath 'regions'
[IO.Directory]::CreateDirectory($regionOutputRoot) | Out-Null
foreach ($currency in $currencyCodes) {
    [IO.Directory]::CreateDirectory((Join-Path $regionOutputRoot $currency.ToLowerInvariant())) | Out-Null
}
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

    foreach ($currency in $currencyCodes) {
        $script:RegionAmbiguities = 0
        Write-Host "  Downloading Azure Retail Prices ($currency)..."
        $retailPrices = Get-RetailPrices -Region $region -Currency $currency
        $priceLookup = New-PriceLookup -RetailPrices $retailPrices

        Write-Host "  Normalizing $currency catalog..."
        $normalized = @($rawSkus | ForEach-Object {
            Convert-Sku -Sku $_ -Region $region -PriceLookup $priceLookup -CpuLookup $cpuLookup
        })

        $catalog = [ordered] @{
            schemaVersion = 1
            generatedAt = $generatedAt
            currencyCode = $currency
            region = $region
            displayName = $displayName
            skus = $normalized
        }
        $currencyOutputPath = Join-Path $regionOutputRoot $currency.ToLowerInvariant()
        Write-DeterministicJson -Value $catalog -Path (Join-Path $currencyOutputPath "$region.json")

        $linuxCount = @($normalized | Where-Object { $null -ne $_.prices.linuxPaygHourly }).Count
        $windowsCount = @($normalized | Where-Object { $null -ne $_.prices.windowsPaygHourly }).Count
        $cpuCount = @($normalized | Where-Object { $null -ne $_.cpuVendor -and $null -ne $_.cpuGeneration }).Count
        Write-Host "  $currency`: $($normalized.Count) VM SKUs"
        Write-Host "  $currency`: $linuxCount with Linux price"
        Write-Host "  $currency`: $windowsCount with Windows price"
        Write-Host "  $currency`: $cpuCount with complete CPU metadata"
        Write-Host "  $currency`: $script:RegionAmbiguities pricing ambiguities"
    }

}

if ($AllRegions -and $ShardCount -eq 1) {
    foreach ($currency in $currencyCodes) {
        $currencyOutputPath = Join-Path $regionOutputRoot $currency.ToLowerInvariant()
        $selectedFileNames = @($selectedRegions | ForEach-Object { "$_.json" })
        Get-ChildItem -LiteralPath $currencyOutputPath -Filter '*.json' -File | Where-Object {
            $_.Name -notin $selectedFileNames
        } | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force
        }
    }
    Get-ChildItem -LiteralPath $regionOutputRoot -Filter '*.json' -File | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
    }
}

$indexCurrencyPath = Join-Path $regionOutputRoot $currencyCodes[0].ToLowerInvariant()
$regionIndex = @(Get-ChildItem -LiteralPath $indexCurrencyPath -Filter '*.json' -File | ForEach-Object {
    $existingCatalog = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
    [ordered] @{
        name = [string] $existingCatalog.region
        displayName = [string] $existingCatalog.displayName
        skuCount = @($existingCatalog.skus).Count
        generatedAt = Convert-ToGeneratedAtString $existingCatalog.generatedAt
    }
} | Sort-Object displayName)
Write-DeterministicJson -Value $regionIndex -Path (Join-Path $OutputPath 'regions.json')

Write-Progress -Activity 'Generating Azure VM catalog' -Completed
Write-Host "Catalog generated in $([IO.Path]::GetFullPath($OutputPath))."
