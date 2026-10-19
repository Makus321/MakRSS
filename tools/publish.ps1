# Публикация читалки на GitHub — одной командой.
#
#   .\tools\publish.ps1                      # собрать изменения и отправить
#   .\tools\publish.ps1 -Message "фикс X"    # со своим сообщением коммита
#   .\tools\publish.ps1 -DryRun              # только показать, что изменится
#
# Схема: рабочая папка не является git-репозиторием (она лежит внутри другого
# репозитория и синхронизируется ownCloud). Поэтому скрипт готовит «зеркало» в
# отдельной папке (по умолчанию %TEMP%\MakRSS), копирует туда проект и оттуда
# отправляет изменения на GitHub.
#
# В публикацию НЕ попадают: data/ (ленты и статьи), rus-host.txt (доступы к
# серверу), *.opml.xml и bazqux-*.xml (личные подписки), preview/, *.log.

[CmdletBinding()]
param(
    [string]$Message = '',
    [string]$Stage = (Join-Path $env:TEMP 'MakRSS'),
    [string]$Remote = 'https://github.com/Makus321/MakRSS.git',
    [string]$Branch = 'main',
    [string]$AuthorName = 'Makus321',
    [string]$AuthorEmail = '<EMAIL_8>',
    [switch]$DryRun
)

# git пишет обычный прогресс в stderr, а PowerShell при 'Stop' считает это ошибкой.
# Поэтому режим 'Continue', а результат каждой команды проверяем по коду возврата.
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'          # не спрашивать пароль в консоли

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'server.mjs'))) {
    throw 'Не найден server.mjs — скрипт должен лежать в <проект>\tools\publish.ps1'
}

function Write-Step($text) { Write-Host "== $text" -ForegroundColor Cyan }
function Write-Note($text) { Write-Host "   $text" -ForegroundColor DarkGray }
function Invoke-Git {
    param([string[]]$GitArgs)
    & git @GitArgs 2>&1 | ForEach-Object { Write-Host "   $_" -ForegroundColor DarkGray }
    return $LASTEXITCODE
}

# --- 1. зеркало: git-репозиторий рядом с проектом ------------------------------
Write-Step "Готовлю зеркало в $Stage"
$hasRepo = Test-Path (Join-Path $Stage '.git')
if (-not $hasRepo) {
    if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
    New-Item -ItemType Directory -Path $Stage | Out-Null
    $null = Invoke-Git @('-C', $Stage, 'init', '-b', $Branch)
    $null = Invoke-Git @('-C', $Stage, 'remote', 'add', 'origin', $Remote)
    if ((Invoke-Git @('-C', $Stage, 'fetch', 'origin', $Branch)) -ne 0) {
        throw 'Не удалось получить репозиторий с GitHub'
    }
    # Встаём на удалённую ветку: так сохраняются LICENSE и история коммитов.
    if ((Invoke-Git @('-C', $Stage, 'checkout', '-B', $Branch, "origin/$Branch")) -ne 0) {
        throw "Не удалось переключиться на ветку $Branch"
    }
} else {
    if ((Invoke-Git @('-C', $Stage, 'fetch', 'origin', $Branch)) -eq 0) {
        $null = Invoke-Git @('-C', $Stage, 'reset', '--hard', "origin/$Branch")
    }
}

# --- 2. копия проекта без личных данных ----------------------------------------
$excludeDirs = @('data', 'preview', 'node_modules', '.git')
$excludeFiles = @('rus-host.txt', '*.opml.xml', 'bazqux-*.xml', '*.log', '*.tmp')

Write-Step 'Копирую проект (без data, доступов и личных подписок)'
# robocopy зеркалит каталоги и убирает удалённые файлы; .git этажа не трогает,
# потому что исключён по имени.
$args = @($root, $Stage, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
$args += '/XD'
$args += $excludeDirs
$args += '/XF'
$args += $excludeFiles
& robocopy @args | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy не смог скопировать проект (код $LASTEXITCODE)" }
$copied = (Get-ChildItem $Stage -Force | Where-Object { $_.Name -ne '.git' }).Count
Write-Note "скопировано объектов верхнего уровня: $copied"

# Файлы, которые есть в репозитории, но не в проекте (LICENSE и подобные),
# robocopy при зеркалировании удалил бы — возвращаем их из git.
$missing = @(& git -C $Stage ls-files 2>$null) | Where-Object { $_ -and -not (Test-Path (Join-Path $Stage $_)) }
foreach ($file in $missing) {
    Write-Note "возвращаю из репозитория: $file"
    $null = Invoke-Git @('-C', $Stage, 'checkout', '--', $file)
}

# --- 3. страховка: в копии не должно быть доступов и данных --------------------
Write-Step 'Проверяю, что в копии нет доступов и личных данных'
$forbidden = @()
foreach ($pattern in @('rus-host.txt', '*.opml.xml', 'bazqux-*.xml')) {
    $found = Get-ChildItem $Stage -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue
    foreach ($file in $found) { $forbidden += $file.FullName }
}
if (Test-Path (Join-Path $Stage 'data')) { $forbidden += (Join-Path $Stage 'data') }
if ($forbidden.Count -gt 0) {
    $forbidden | ForEach-Object { Write-Host "   лишнее: $_" -ForegroundColor Red }
    throw 'В копии оказались личные файлы — публикация остановлена.'
}
$textFiles = Get-ChildItem $Stage -Recurse -File -Include *.mjs, *.js, *.html, *.css, *.md, *.sh, *.cmd -ErrorAction SilentlyContinue
# Домен в скриптах установки — это нормально, а вот IP сервера публиковать не нужно.
$leaks = Select-String -Path $textFiles.FullName -Pattern '194.147.115', '185.221.19' -SimpleMatch -ErrorAction SilentlyContinue
if ($leaks) {
    $leaks | Select-Object -First 5 | ForEach-Object { Write-Host "   $($_.Filename):$($_.LineNumber) — $($_.Line.Trim())" -ForegroundColor Red }
    throw 'В файлах найдены упоминания доступов — публикация остановлена.'
}
Write-Note 'чисто'

# --- 4. что изменилось ---------------------------------------------------------
$null = Invoke-Git @('-C', $Stage, 'add', '-A')
$pending = @(& git -C $Stage status --porcelain 2>$null) | Where-Object { $_ }
if (-not $pending.Count) {
    Write-Step 'Изменений нет — отправлять нечего'
    return
}

Write-Step 'Что изменилось'
$pending | Select-Object -First 20 | ForEach-Object { Write-Note $_.Trim() }
if ($pending.Count -gt 20) { Write-Note "… и ещё $($pending.Count - 20)" }

if ($DryRun) {
    Write-Step 'DryRun: коммит и отправка пропущены'
    return
}

# --- 5. коммит и отправка ------------------------------------------------------
if (-not $Message) { $Message = 'Обновление читалки: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
Write-Step "Коммит: $Message"
$code = Invoke-Git @('-C', $Stage, '-c', "user.name=$AuthorName", '-c', "user.email=$AuthorEmail", 'commit', '-m', $Message)
if ($code -ne 0) { throw 'git commit не удался' }

Write-Step "Отправляю в $Remote"
if ((Invoke-Git @('-C', $Stage, 'push', '-u', 'origin', $Branch)) -ne 0) {
    throw 'git push не удался — проверьте доступ к GitHub'
}

$sha = (& git -C $Stage rev-parse --short HEAD)
$url = $Remote -replace '\.git$', ''
Write-Step 'Готово'
Write-Note "коммит $sha"
Write-Note "изменения: $url/commit/$sha"
