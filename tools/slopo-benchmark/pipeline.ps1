<#
.SYNOPSIS
Runs the benchmark-selected source-only Slopo operational pipeline.

.EXAMPLE
.\tools\slopo-benchmark\pipeline.ps1 all

.EXAMPLE
.\tools\slopo-benchmark\pipeline.ps1 status
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("index", "embed", "analyze", "all", "status")]
    [string] $Command = "all",

    [string] $Config = "tools/slopo-benchmark/slopo.pipeline.yaml",
    [string] $PythonPath = "",
    [string] $ExpectedSlopoVersion = "0.5.0",
    [switch] $NoCache,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$benchmarkDirectory = Split-Path -Parent $PSCommandPath
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $benchmarkDirectory "..\..")).Path
$pipelineScript = Join-Path $benchmarkDirectory "operational_pipeline.py"

if ($NoCache -and $Command -notin @("embed", "all")) {
    throw "-NoCache is valid only with embed or all."
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA is unavailable; provide -PythonPath explicitly."
    }
    $PythonPath = Join-Path $env:APPDATA "uv\tools\slopo\Scripts\python.exe"
} elseif (-not [IO.Path]::IsPathRooted($PythonPath)) {
    $PythonPath = Join-Path $repositoryRoot $PythonPath
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "Slopo's Python interpreter was not found at '$PythonPath'. Install Slopo with uv or provide -PythonPath."
}
$PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path

if (-not [IO.Path]::IsPathRooted($Config)) {
    $Config = Join-Path $repositoryRoot $Config
}
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
    throw "Pipeline config was not found at '$Config'."
}
$Config = (Resolve-Path -LiteralPath $Config).Path

function Format-CommandArgument {
    param([Parameter(Mandatory = $true)][string] $Value)

    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-PipelinePython {
    param([Parameter(Mandatory = $true)][string[]] $Arguments)

    $rendered = @($PythonPath) + $Arguments | ForEach-Object {
        Format-CommandArgument -Value $_
    }
    Write-Host ("> " + ($rendered -join " "))
    if ($DryRun) {
        return
    }

    Push-Location $repositoryRoot
    try {
        & $PythonPath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Pipeline command failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

Invoke-PipelinePython -Arguments @(
    "-c",
    "import importlib.metadata as m; import sys, numpy, slopo; actual=m.version('slopo'); expected=sys.argv[1]; print('Slopo', actual, 'NumPy', numpy.__version__); sys.exit('Expected Slopo ' + expected + ', found ' + actual) if actual != expected else None",
    $ExpectedSlopoVersion
)

$arguments = @($pipelineScript, $Command, "--config", $Config)
if ($NoCache) {
    $arguments += "--no-cache"
}
Invoke-PipelinePython -Arguments $arguments

if ($Command -in @("analyze", "all")) {
    Write-Host "Merged report: $(Join-Path $repositoryRoot '.slopo\pipeline\results\summary.md')"
}
