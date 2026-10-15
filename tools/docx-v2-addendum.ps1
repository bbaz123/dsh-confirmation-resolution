# Append a V1/V2 version note to the three normative .docx specs.
#
# The .docx files are the authored specification sources; their body text
# describes the V1 contract, which is unchanged. V2 adds a second, versioned
# contract, so each spec gets a short, clearly marked addendum that says so and
# points at the authoritative implementation instead of duplicating the algorithm
# in two places.
#
# The edit is surgical: only word/document.xml is rewritten, inside the existing
# ZIP, with every other entry preserved byte-for-byte. Rollback is `git checkout`
# on the three files.

Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$addenda = @{
  '01_DSH_System_Prompt_待确认事项触发规则.docx' = @(
    '【2026-10-15 版本补充：V1 / V2 双契约】',
    '本文档正文描述的是 V1 契约（confirmation_resolution），该契约保持不变。',
    'V2（confirmation_resolution_v2）只新增一个版本化工具入口与一条独立规则段落（confirmation:policy.v2）；触发条件与 V1 完全相同，V2 不扩大作用域，也不处理普通任务。',
    'V2 默认关闭，只有装配时显式设置 enableDecisionV2: true 才注册；未启用时本文档描述的行为即为全部行为。',
    'V2 的触发规则文本以 lib/rules.js 的 RULES_V2 为准，本补充不重复其条文。'
  )
  '02_Confirmation_Resolution_Plugin_执行规则.docx' = @(
    '【2026-10-15 版本补充：V1 / V2 双契约】',
    '本文档正文描述的是 V1 契约（confirmation_resolution），该契约保持不变。',
    'V2（confirmation_resolution_v2）在固定质量矩阵之外增加：场景化多维比较（ui_preference / accessibility / code_change / external_action / urgent_fix / generic）、三值证据模型（PASS / FAIL / UNKNOWN，UNKNOWN 不得当作通过）、REQUEST_APPROVAL 与 REJECT 两个新结果、以及版本化决策令牌 decision_revision。',
    'V2 的算法实现位于 lib/decision-v2.js、lib/evidence.js、lib/policies.js、lib/trace.js，账本扩展位于 lib/ledger.js，装配与守卫位于 lib/index.js。',
    'V1 与 V2 互不驱动：同一编号由哪一版登记，就只能由那一版继续驱动（ITEM_VERSION_MISMATCH）。'
  )
  '03_DSH_待确认事项决策规范_维护与测试基准.docx' = @(
    '【2026-10-15 版本补充：V1 / V2 双契约】',
    '本文档正文描述的是 V1 契约（confirmation_resolution）的规范与验收基准，该基准保持不变。',
    'V2（confirmation_resolution_v2）的验收基准以可执行测试为准：test/decision-v2.test.mjs（T01–T16 场景矩阵与属性测试）、test/evidence.test.mjs、test/policies.test.mjs、test/ledger-v2.test.mjs、test/v2-tool.test.mjs，以及 verify/wiring.mjs 中的 V2 装配检查项。',
    '分层实测口径：离线 130 用例、宿主 187 用例、装配 32 项（可用 node --test --experimental-test-isolation=none 复现）。',
    '本补充只标注版本边界，不替代仓库 README 的「V2」章节与代码本身。'
  )
}

function ConvertTo-XmlText([string] $value) {
  $value.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}

function Add-Addendum([string] $docxPath, [string[]] $lines) {
  $zip = [System.IO.Compression.ZipFile]::Open($docxPath, 'Update')
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
    if ($null -eq $entry) { throw "word/document.xml not found in $docxPath" }
    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    $xml = $reader.ReadToEnd()
    $reader.Close()
    if ($xml -like '*2026-10-15 版本补充*') {
      Write-Output "SKIP  $([System.IO.Path]::GetFileName($docxPath)) (addendum already present)"
      return
    }
    $paragraphs = ''
    foreach ($line in $lines) {
      $paragraphs += '<w:p><w:r><w:t xml:space="preserve">' + (ConvertTo-XmlText $line) + '</w:t></w:r></w:p>'
    }
    $marker = '</w:body>'
    $index = $xml.LastIndexOf($marker)
    if ($index -lt 0) { throw "no </w:body> in $docxPath" }
    $updated = $xml.Substring(0, $index) + $paragraphs + $xml.Substring($index)
    $entry.Delete()
    $newEntry = $zip.CreateEntry('word/document.xml', [System.IO.Compression.CompressionLevel]::Optimal)
    $writer = New-Object System.IO.StreamWriter($newEntry.Open(), (New-Object System.Text.UTF8Encoding($false)))
    $writer.Write($updated)
    $writer.Close()
  } finally {
    $zip.Dispose()
  }
}

function Verify-Addendum([string] $docxPath) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($docxPath)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    $xml = $reader.ReadToEnd()
    $reader.Close()
    # Parse as XML: a malformed document would throw here.
    $doc = New-Object System.Xml.XmlDocument
    $doc.LoadXml($xml)
    $texts = $doc.GetElementsByTagName('w:t')
    $all = ($texts | ForEach-Object { $_.InnerText }) -join ''
    if ($all -notlike '*2026-10-15 版本补充*') { throw "addendum text missing after rewrite" }
    return [pscustomobject]@{ Paragraphs = $doc.GetElementsByTagName('w:p').Count; TextLength = $all.Length }
  } finally {
    $zip.Dispose()
  }
}

foreach ($name in $addenda.Keys) {
  $path = Join-Path $root $name
  if (-not (Test-Path $path)) { throw "missing spec file: $path" }
  Add-Addendum $path $addenda[$name]
  $verify = Verify-Addendum $path
  Write-Output ("OK    {0}  paragraphs={1} textLength={2}" -f $name, $verify.Paragraphs, $verify.TextLength)
}
