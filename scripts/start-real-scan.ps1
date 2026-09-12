param(
    [string]$Region = "ap-northeast-1",
    [string]$Profile = "default",
    [switch]$EnableBedrock,
    [switch]$AllowRootSession
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$awsCli = Join-Path $env:LOCALAPPDATA "Programs\Amazon\AWSCLIV2\aws.exe"
$uvicorn = Join-Path $projectRoot ".venv\Scripts\uvicorn.exe"

if (-not (Test-Path -LiteralPath $awsCli)) {
    throw "AWS CLI not found at $awsCli"
}

if (-not (Test-Path -LiteralPath $uvicorn)) {
    throw "Project virtual environment is missing. Run: uv venv .venv"
}

$identity = & $awsCli sts get-caller-identity --profile $Profile --region $Region --output json |
    ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $identity) {
    throw "AWS identity verification failed. Run: & '$awsCli' login --region $Region"
}

if ($identity.Arn -like "*:root" -and -not $AllowRootSession) {
    throw (
        "The current AWS login is root. For this one-time read-only test, rerun with " +
        "-AllowRootSession. Create a non-root development identity before deployment."
    )
}

$env:Path = "$(Split-Path -Parent $awsCli);$env:Path"
$env:AWS_PROFILE = $Profile
$env:AWS_REGION = $Region
$env:ALLOW_AWS_SCAN = "true"
$env:BEDROCK_MODEL_ID = if ($EnableBedrock) {
    "jp.amazon.nova-2-lite-v1:0"
} else {
    ""
}

Set-Location -LiteralPath $projectRoot
Write-Host "AWS identity: $($identity.Arn)"
Write-Host "Starting FinOpsSec at http://127.0.0.1:8000"
& $uvicorn app.main:app --reload
