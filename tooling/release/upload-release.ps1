# Uploads the release files to a GitHub DRAFT release, one file per call, and tries again every 30 seconds
# until each file shows as uploaded. A half-uploaded asset of the same name is removed from the draft first.
# Usage: .\upload-release.ps1 -Tag v1.1.1 -Dir C:\jgp\v111\candidate-3ec5b951 [-Repo hadimoti/joy-media] [-MaxTries 120]
# It never publishes, never touches a published release, and never deletes a file from the release folder.
param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Dir,
    [string]$Repo = 'hadimoti/joy-media',
    [int]$MaxTries = 120,
    [int]$WaitSeconds = 30
)
$ErrorActionPreference = 'Continue'
if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { throw "Folder not found: $Dir" }

# The DRAFT with this tag. Filtering is done here on the parsed JSON, so no quoting reaches gh.
function Get-Draft {
    $all = (gh api "repos/$Repo/releases" --paginate 2>$null) -join "`n" | ConvertFrom-Json
    return @($all | Where-Object { $_.tag_name -eq $Tag -and $_.draft -eq $true }) | Select-Object -First 1
}
$draft = Get-Draft
if ($null -eq $draft) { throw "No draft release with tag $Tag in $Repo (a published release is never changed by this script)." }

$failed = @()
foreach ($file in (Get-ChildItem -LiteralPath $Dir -File | Sort-Object Name)) {
    $name = $file.Name
    $done = $false
    for ($try = 1; $try -le $MaxTries -and -not $done; $try++) {
        $draft = Get-Draft
        $asset = @($draft.assets | Where-Object { $_.name -eq $name }) | Select-Object -First 1
        if ($null -ne $asset -and $asset.state -eq 'uploaded') {
            Write-Output "$name already uploaded"
            $done = $true
            break
        }
        # A half-uploaded asset of the same name (draft only) is removed before the next try.
        if ($null -ne $asset) { gh api -X DELETE "repos/$Repo/releases/assets/$($asset.id)" 2>&1 | Out-Null }
        Write-Output "try $try uploading $name ($($file.Length) bytes)"
        gh release upload $Tag $file.FullName --repo $Repo --clobber 2>&1 | Select-Object -Last 2
        $draft = Get-Draft
        $asset = @($draft.assets | Where-Object { $_.name -eq $name }) | Select-Object -First 1
        if ($null -ne $asset -and $asset.state -eq 'uploaded') { $done = $true; Write-Output "$name uploaded"; break }
        Start-Sleep -Seconds $WaitSeconds
    }
    if (-not $done) { $failed += $name }
}
$draft = Get-Draft
$draft.assets | ForEach-Object { "$($_.name) $($_.size) $($_.state)" }
if ($failed.Count -gt 0) { throw "Not uploaded: $($failed -join ', ')" }
