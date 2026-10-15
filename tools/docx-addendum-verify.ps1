# Verify the .docx addendum edit against the pre-edit copy of each spec.
#
# Checks three things per file, all against `git show HEAD:<file>`:
#   1. the ZIP still holds the same entry names (no structure was lost);
#   2. every original paragraph text is still present, in order;
#   3. the addendum paragraphs are appended after all of them, and document.xml
#      still parses as XML.
#
# Run: pwsh -NoProfile -File tools/docx-addendum-verify.ps1 [-OriginalDir <dir>]

param([string] $OriginalDir = '')

Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
if ($OriginalDir -eq '') { throw 'pass -OriginalDir pointing at the pre-edit copies' }

function Read-DocumentXml([string] $path) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    $xml = $reader.ReadToEnd()
    $reader.Close()
    return $xml
  } finally {
    $zip.Dispose()
  }
}

function Get-ParagraphTexts([string] $xml) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.LoadXml($xml)
  $result = @()
  foreach ($p in $doc.GetElementsByTagName('w:p')) {
    $result += (($p.GetElementsByTagName('w:t') | ForEach-Object { $_.InnerText }) -join '')
  }
  return , $result
}

function Get-EntryNames([string] $path) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  try { return , ($zip.Entries | ForEach-Object { $_.FullName } | Sort-Object) } finally { $zip.Dispose() }
}

$failures = 0
foreach ($file in Get-ChildItem (Join-Path $root '*.docx')) {
  $before = Join-Path $OriginalDir $file.Name
  if (-not (Test-Path $before)) { Write-Output "FAIL  $($file.Name): no pre-edit copy"; $failures++; continue }

  $entriesBefore = Get-EntryNames $before
  $entriesAfter = Get-EntryNames $file.FullName
  $lostEntries = $entriesBefore | Where-Object { $entriesAfter -notcontains $_ }
  if ($lostEntries.Count -gt 0) { Write-Output "FAIL  $($file.Name): lost zip entries: $($lostEntries -join ', ')"; $failures++; continue }

  $beforeTexts = Get-ParagraphTexts (Read-DocumentXml $before)
  $afterTexts = Get-ParagraphTexts (Read-DocumentXml $file.FullName)

  if ($afterTexts.Count -lt $beforeTexts.Count) {
    Write-Output "FAIL  $($file.Name): paragraph count dropped $($beforeTexts.Count) -> $($afterTexts.Count)"
    $failures++
    continue
  }
  $mismatch = -1
  for ($i = 0; $i -lt $beforeTexts.Count; $i++) {
    if ($beforeTexts[$i] -ne $afterTexts[$i]) { $mismatch = $i; break }
  }
  if ($mismatch -ge 0) {
    Write-Output "FAIL  $($file.Name): paragraph $mismatch changed: '$($beforeTexts[$mismatch])' -> '$($afterTexts[$mismatch])'"
    $failures++
    continue
  }
  $appended = $afterTexts.Count - $beforeTexts.Count
  $joined = ($afterTexts | Select-Object -Skip $beforeTexts.Count) -join '|'
  if ($joined -notlike '*2026-10-15 版本补充*') {
    Write-Output "FAIL  $($file.Name): appended paragraphs do not carry the addendum marker"
    $failures++
    continue
  }
  Write-Output ("OK    {0}: entries={1} paragraphs {2} -> {3} (+{4})" -f $file.Name, $entriesAfter.Count, $beforeTexts.Count, $afterTexts.Count, $appended)
}
Write-Output "failures=$failures"
if ($failures -gt 0) { exit 1 }
