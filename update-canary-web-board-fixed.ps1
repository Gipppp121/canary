$ErrorActionPreference = "Stop"

$repo = (Get-Location).Path
$readme = Join-Path $repo "README.md"
$package = Join-Path $repo "package.json"
$boardCode = Join-Path $repo "src\ui\web-board.ts"
$incomingImage = Join-Path $PSScriptRoot "assets\web-board.png"
$targetImage = Join-Path $repo "assets\web-board.png"

if (-not (Test-Path $readme) -or -not (Test-Path $package)) {
  throw "Run this script from the root of your canary repo (the folder with README.md and package.json)."
}
if (-not (Test-Path $boardCode)) {
  throw "src/ui/web-board.ts is missing. Apply the final board patch first."
}
if (-not (Test-Path $incomingImage)) {
  throw "assets/web-board.png is missing next to this script. Extract the whole ZIP into the repo root first."
}

New-Item -ItemType Directory -Force -Path (Split-Path $targetImage) | Out-Null

# If the ZIP was extracted directly into the repo, source and destination are the same file.
# In that case, keep it in place instead of trying to copy it onto itself.
$incomingResolved = (Resolve-Path $incomingImage).Path
$targetResolved = (Resolve-Path $targetImage).Path
if ($incomingResolved -ne $targetResolved) {
  Copy-Item -Force $incomingImage $targetImage
} else {
  Write-Host "web-board.png is already in assets/; skipping copy." -ForegroundColor DarkGray
}

$text = Get-Content $readme -Raw
$marker = 'Full field reference: [`docs/BOARD.md`](docs/BOARD.md).'

$block = @'

### Persistent web board

Canary also ships a local browser board that remembers snapshots between sweeps and turns the watcher into a small monitoring desk: token table on the left, selected-position memory on the right, search + `WATCH` / `LEAVE` filters, dev-share history, pool/curve activity, fees, deployer context, and deterministic signal history.

[![open local board](https://img.shields.io/badge/open_local_board-127.0.0.1%3A4663-B7FF00?style=flat-square&labelColor=0A0D0B)](http://127.0.0.1:4663)

![Canary persistent web board](assets/web-board.png)

Run the watcher in one terminal:

```bash
npm run canary -- watch --token 0xTOKEN --interval 10
```

Then open the board from a second terminal:

```bash
npm run board -- --open
```

The board lives at [`http://127.0.0.1:4663`](http://127.0.0.1:4663) and is intentionally local-only. The link works on the machine where Canary is running; it is not a hosted public dashboard.

Board memory is stored under `.canary/` and survives browser refreshes and process restarts. It contains observations only — no private key, signer, approvals, or transaction path.
'@

if ($text -notmatch '### Persistent web board') {
  if ($text.Contains($marker)) {
    $text = $text.Replace($marker, $marker + $block)
  } else {
    $anchor = "---`n`n## What Canary replaces"
    if ($text.Contains($anchor)) {
      $text = $text.Replace($anchor, $block + "`n`n---`n`n## What Canary replaces")
    } else {
      $text = $text + "`n" + $block
    }
  }
}

Set-Content -Path $readme -Value $text -Encoding UTF8

# Make sure the board command is documented by package.json. The final board patch already adds it,
# but this keeps the README update self-checking.
$pkgText = Get-Content $package -Raw
if ($pkgText -notmatch '"board"\s*:') {
  $needle = '"canary": "tsx src/cli.ts",'
  $replacement = '"canary": "tsx src/cli.ts",' + "`r`n    " + '"board": "tsx src/ui/web-board.ts",'
  if (-not $pkgText.Contains($needle)) {
    throw 'Could not add the board npm script automatically. package.json has an unexpected shape.'
  }
  $pkgText = $pkgText.Replace($needle, $replacement)
  Set-Content -Path $package -Value $pkgText -Encoding UTF8
}

Write-Host "README + web board screenshot prepared." -ForegroundColor Green
Write-Host "Running checks..." -ForegroundColor Cyan

npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
npm test
if ($LASTEXITCODE -ne 0) { throw "tests failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

git add -A
$pending = git status --porcelain
if ($pending) {
  git commit -m "add persistent web board showcase"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
  git push
  if ($LASTEXITCODE -ne 0) { throw "git push failed" }
  Write-Host "DONE. Canary web board + screenshot are on GitHub." -ForegroundColor Green
} else {
  Write-Host "Nothing new to commit. README already contains the web board section." -ForegroundColor Yellow
}
