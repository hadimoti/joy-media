function Get-ChecksummedFile([string]$ChecksumsText, [string]$FileName) {
    $escaped = [regex]::Escape($FileName)
    $matches = @([regex]::Matches($ChecksumsText, "(?m)^([0-9a-f]{64})  $escaped\s*$"))
    if ($matches.Count -ne 1) { throw "Release checksum file does not contain exactly one entry for $FileName" }
    return $matches[0].Groups[1].Value
}

function Get-ArchiveEntrySha256([string]$ArchivePath, [string]$ArchiveEntryName) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $normalizedEntryName = $ArchiveEntryName.Replace('\', '/')
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $entries = @($archive.Entries | Where-Object {
            $_.FullName.Equals($normalizedEntryName, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($entries.Count -ne 1) { throw "Release archive does not contain exactly one entry for $ArchiveEntryName" }
        $entryStream = $entries[0].Open()
        try {
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try {
                $digest = $algorithm.ComputeHash($entryStream)
                return [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
            }
            finally {
                $algorithm.Dispose()
            }
        }
        finally {
            $entryStream.Dispose()
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Get-ChecksummedArchiveEntryHash(
    [string]$ChecksumsText,
    [string]$FileName,
    [string]$ArchivePath,
    [string]$ArchiveEntryName
) {
    $escaped = [regex]::Escape($FileName)
    $namedEntries = @([regex]::Matches($ChecksumsText, "(?m)^([^\r\n]+)  $escaped\s*$"))
    if ($namedEntries.Count -gt 1) { throw "Release checksum file contains duplicate entries for $FileName" }
    if ($namedEntries.Count -eq 1) {
        $checksum = $namedEntries[0].Groups[1].Value
        if ($checksum -notmatch '^[0-9a-f]{64}$') { throw "Release checksum entry is malformed for $FileName" }
        return $checksum
    }
    return Get-ArchiveEntrySha256 -ArchivePath $ArchivePath -ArchiveEntryName $ArchiveEntryName
}
