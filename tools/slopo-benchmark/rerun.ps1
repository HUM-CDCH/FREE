<#
.SYNOPSIS
Runs or resumes the reproducible Slopo embedding benchmark workflow.

.EXAMPLE
.\tools\slopo-benchmark\rerun.ps1 benchmark

.EXAMPLE
.\tools\slopo-benchmark\rerun.ps1 validate -ValidationId starlette-2026-08 `
  -SourceRoot .venv\Lib\site-packages\starlette `
  -SourceDistribution starlette -SourceVersion 1.0.0

.EXAMPLE
.\tools\slopo-benchmark\rerun.ps1 score -ValidationId starlette-2026-08
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("benchmark", "validate", "resume", "score", "test")]
    [string] $Command = "benchmark",

    [string] $ValidationId = "",
    [string] $SourceRoot = "",
    [string] $SourceDistribution = "",
    [string] $SourceVersion = "",
    [string] $PythonPath = "",
    [string] $ExpectedSlopoVersion = "0.5.0",
    [switch] $NoCache,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$benchmarkDirectory = Split-Path -Parent $PSCommandPath
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $benchmarkDirectory "..\..")).Path
$resultsDirectory = Join-Path $benchmarkDirectory "results"

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

function Format-CommandArgument {
    param([Parameter(Mandatory = $true)][string] $Value)

    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Invoke-BenchmarkPython {
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
            throw "Python command failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Assert-ValidationId {
    if ([string]::IsNullOrWhiteSpace($ValidationId)) {
        throw "-$Command requires -ValidationId. Use a new lowercase ID for every holdout."
    }
    if ($ValidationId -notmatch '^[a-z0-9-]+$') {
        throw "ValidationId may contain only lowercase letters, digits, and hyphens."
    }
}

$hasSourceRoot = -not [string]::IsNullOrWhiteSpace($SourceRoot)
$hasDistribution = -not [string]::IsNullOrWhiteSpace($SourceDistribution)
$hasVersion = -not [string]::IsNullOrWhiteSpace($SourceVersion)

if ($hasDistribution -xor $hasVersion) {
    throw "-SourceDistribution and -SourceVersion must be supplied together."
}
if (($hasDistribution -or $hasVersion) -and -not $hasSourceRoot) {
    throw "-SourceDistribution and -SourceVersion require -SourceRoot."
}
if ($Command -ne "validate" -and ($hasSourceRoot -or $hasDistribution -or $hasVersion)) {
    throw "Source options are valid only with the validate command."
}
if ($NoCache -and $Command -ne "benchmark") {
    throw "-NoCache is valid only with the benchmark command."
}

$benchmarkScript = Join-Path $benchmarkDirectory "benchmark.py"
$ensembleScript = Join-Path $benchmarkDirectory "ensemble.py"
$validationScript = Join-Path $benchmarkDirectory "blind_validation.py"

Invoke-BenchmarkPython -Arguments @(
    "-c",
    "import importlib.metadata as m; import sys, numpy, slopo; actual=m.version('slopo'); expected=sys.argv[1]; print('Slopo', actual, 'NumPy', numpy.__version__); sys.exit('Expected Slopo ' + expected + ', found ' + actual) if actual != expected else None",
    $ExpectedSlopoVersion
)

switch ($Command) {
    "benchmark" {
        $arguments = @($benchmarkScript, "all")
        if ($NoCache) {
            $arguments += "--no-cache"
        }
        Invoke-BenchmarkPython -Arguments $arguments
        Invoke-BenchmarkPython -Arguments @($ensembleScript)
        Invoke-BenchmarkPython -Arguments @(
            "-m", "unittest", "discover",
            "-s", $benchmarkDirectory,
            "-p", "test_*.py"
        )
        Write-Host "Benchmark report: $(Join-Path $resultsDirectory 'ensemble-summary.md')"
    }

    "validate" {
        Assert-ValidationId
        $freezePath = Join-Path $resultsDirectory "blind-validation-$ValidationId-freeze.json"
        if (Test-Path -LiteralPath $freezePath) {
            throw "Validation '$ValidationId' already exists. Use resume, score, or a new ID; frozen runs are immutable."
        }

        $prepareArguments = @($validationScript, "prepare", "--validation-id", $ValidationId)
        if ($hasSourceRoot) {
            if (-not [IO.Path]::IsPathRooted($SourceRoot)) {
                $SourceRoot = Join-Path $repositoryRoot $SourceRoot
            }
            if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
                throw "SourceRoot was not found: '$SourceRoot'."
            }
            $SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
            $prepareArguments += @("--source-root", $SourceRoot)
            if ($hasDistribution) {
                $prepareArguments += @(
                    "--source-distribution", $SourceDistribution,
                    "--source-version", $SourceVersion
                )
            }
        }

        Invoke-BenchmarkPython -Arguments $prepareArguments
        try {
            Invoke-BenchmarkPython -Arguments @(
                $validationScript, "run", "--validation-id", $ValidationId
            )
        } catch {
            Write-Warning "The frozen run can be resumed with: $PSCommandPath resume -ValidationId $ValidationId"
            throw
        }

        $queuePath = Join-Path $resultsDirectory "blind-validation-$ValidationId-review-queue.md"
        $decisionsPath = Join-Path $resultsDirectory "blind-validation-$ValidationId-decisions.json"
        Write-Host "Review queue: $queuePath"
        Write-Host "Record judgments: $decisionsPath"
        Write-Host "Then score: $PSCommandPath score -ValidationId $ValidationId"
    }

    "resume" {
        Assert-ValidationId
        $freezePath = Join-Path $resultsDirectory "blind-validation-$ValidationId-freeze.json"
        if (-not (Test-Path -LiteralPath $freezePath -PathType Leaf)) {
            throw "No frozen validation named '$ValidationId' exists. Start it with validate."
        }
        Invoke-BenchmarkPython -Arguments @(
            $validationScript, "run", "--validation-id", $ValidationId
        )
    }

    "score" {
        Assert-ValidationId
        $freezePath = Join-Path $resultsDirectory "blind-validation-$ValidationId-freeze.json"
        if (-not (Test-Path -LiteralPath $freezePath -PathType Leaf)) {
            throw "No frozen validation named '$ValidationId' exists. Start it with validate."
        }
        Invoke-BenchmarkPython -Arguments @(
            $validationScript, "score", "--validation-id", $ValidationId
        )
        Write-Host "Validation report: $(Join-Path $resultsDirectory "blind-validation-$ValidationId-summary.md")"
    }

    "test" {
        Invoke-BenchmarkPython -Arguments @(
            "-m", "unittest", "discover",
            "-s", $benchmarkDirectory,
            "-p", "test_*.py"
        )
    }
}
