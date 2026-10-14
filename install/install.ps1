# autotrack installer for Windows (Windows PowerShell 5.1). No admin, no Node needed.
# Re-running it updates in place. The recorder also updates itself (src/update.ts): each version
# lives in <data>\versions\<v> and <data>\app is a junction to the current one.
#
#   $env:AUTOTRACK='<install code>'; irm https://raw.githubusercontent.com/wrenautomation/autotrack/main/install/install.ps1 | iex   (in PowerShell)
#
# The code comes from `autobrowse autotrack enroll <device>`. Other env, for tests:
#   AUTOTRACK_BUNDLE          local path or URL of the bundle instead of the latest release;
#                             SHA256SUMS is read from beside it
#   AUTOTRACK_DIR             data dir (default %LOCALAPPDATA%\autotrack)
#   AUTOTRACK_ENDPOINT        S3-compatible endpoint instead of AWS
#   AUTOTRACK_NO_AUTOSTART=1  install everything but register and start nothing
#   AUTOTRACK_NO_BROWSER=1    unpack the extension but don't copy its path or open a browser
#   AUTOTRACK_STEP            run one part: check | install | start | extension (default: all of them).
#                             The setup program (installer/windows) runs them one at a time:
#                               check      the code and the bundle's checksum; touches nothing
#                               install    unpack, config, extension files, PATH, login item (not started)
#                               start      start the recorder now and run doctor
#                               extension  copy the extension folder path and open Chrome or Edge
#
# Run through `iex`, so it never calls `exit` (that would close the window): errors throw.

$ErrorActionPreference = 'Stop'
# Started from PowerShell 7, Windows PowerShell inherits 7's module path and can't load its own
# modules (Get-FileHash, ScheduledTasks, ...). Use the 5.1 defaults.
if ($PSVersionTable.PSVersion.Major -le 5) {
    $env:PSModulePath = @(
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\Modules'),
        (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')
    ) -join ';'
}
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest crawls with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

& {
    $Repo = 'wrenautomation/autotrack'
    $Task = 'autotrack'
    $RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    # The extension ships unpacked until it is on the Chrome Web Store. Set $StoreLive = $true once
    # the listing exists: the installer then prints $StoreUrl and no longer unpacks or opens anything.
    $StoreLive = $false
    $StoreUrl = 'https://chromewebstore.google.com/detail/autotrack/colpoheiepckdglfmebejhelggjikjim'

    function Say([string]$msg) { Write-Host $msg }
    # Native commands that may write to stderr: under 'Stop', PowerShell 5.1 would throw on it.
    function Quiet([scriptblock]$block) {
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $block } finally { $ErrorActionPreference = $saved }
    }
    function Die([string]$msg) { Write-Host "autotrack install: $msg" -ForegroundColor Red; throw "autotrack install failed: $msg" }

    $step = if ($env:AUTOTRACK_STEP) { $env:AUTOTRACK_STEP.Trim().ToLower() } else { 'all' }
    if (@('all', 'check', 'install', 'start', 'extension') -notcontains $step) {
        Die "AUTOTRACK_STEP must be all, check, install, start or extension (got '$step')."
    }
    $doInstall = @('all', 'check', 'install') -contains $step
    $doStart = @('all', 'start') -contains $step
    $doExtension = @('all', 'extension') -contains $step

    $data = if ($env:AUTOTRACK_DIR) { $env:AUTOTRACK_DIR } else { Join-Path $env:LOCALAPPDATA 'autotrack' }
    $app = Join-Path $data 'app'
    $node = Join-Path $app 'node\node.exe'
    $cli = Join-Path $app 'dist\cli.js'
    $versions = Join-Path $data 'versions'
    $vbs = Join-Path $data 'autotrack.vbs'
    $ext = Join-Path $data 'extension'
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $launch = "`"$wscript`" //B //Nologo `"$vbs`""
    $autostart = -not $env:AUTOTRACK_NO_AUTOSTART
    $registered = $false

    function Fetch([string]$src, [string]$dest) {
        if ($src -match '^https?://') {
            try { Invoke-WebRequest -UseBasicParsing -Uri $src -OutFile $dest } catch { Die "download failed: $src ($($_.Exception.Message))" }
        } else {
            $path = $src -replace '^file:///?', ''
            if (-not (Test-Path -LiteralPath $path)) { Die "not found: $src" }
            Copy-Item -LiteralPath $path -Destination $dest
        }
    }

    # Browser extension: three steps per browser found.
    function Find-Browser([string]$exe, [string[]]$dirs) {
        foreach ($root in 'HKCU', 'HKLM') {
            $p = (Get-ItemProperty -Path "${root}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction SilentlyContinue).'(default)'
            if ($p -and (Test-Path -LiteralPath $p)) { return $p }
        }
        foreach ($d in $dirs) {
            $p = Join-Path $d $exe
            if (Test-Path -LiteralPath $p) { return $p }
        }
        return $null
    }
    function Extension-Help {
        Say ''
        if ($StoreLive) {
            Say "Browser clicks: add the autotrack extension to Chrome or Edge: $StoreUrl"
        } elseif ($ext) {
            Say 'Browser clicks: load the autotrack extension in Chrome or Edge.'
            Say "Folder: $ext"
            $pf = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
            $found = @()
            if (-not $env:AUTOTRACK_NO_BROWSER) {
                $chrome = Find-Browser 'chrome.exe' ($pf | ForEach-Object { Join-Path $_ 'Google\Chrome\Application' })
                $edge = Find-Browser 'msedge.exe' ($pf | ForEach-Object { Join-Path $_ 'Microsoft\Edge\Application' })
                if ($chrome) { $found += , @('Chrome', 'chrome', $chrome) }
                if ($edge) { $found += , @('Edge', 'edge', $edge) }
            }
            if ($found.Count -gt 0) {
                try { Set-Clipboard -Value $ext; Say '(Copied to your clipboard.)' } catch { }
                foreach ($b in $found) {
                    Say ''
                    Say "$($b[0]):"
                    Say "  1. Open $($b[1])://extensions and turn on Developer mode (top right)."
                    Say '  2. Click Load unpacked.'
                    Say '  3. Paste the folder (already copied) into the Folder box, then Select Folder.'
                    try { Start-Process -FilePath $b[2] -ArgumentList "$($b[1])://extensions" } catch { Say "  (Could not open it: $($_.Exception.Message))" }
                }
                Say ''
                Say 'If autotrack is already listed there, press its reload button instead.'
            } else {
                Say 'Open chrome://extensions (or edge://extensions), turn on Developer mode, Load unpacked, pick that folder.'
            }
        }
    }

    function Running {
        Quiet { & $node $cli status *> $null }
        return ($LASTEXITCODE -eq 0)
    }

    if ($doInstall) {
        $code = $env:AUTOTRACK
        if (-not $code) { Die 'AUTOTRACK is not set. Run the whole line that `autobrowse autotrack enroll <device>` printed.' }
        if ($code -notmatch '^[A-Za-z0-9_-]+$') { Die 'AUTOTRACK is not an install code (base64url expected).' }
        if (-not [Environment]::Is64BitOperatingSystem) { Die 'autotrack needs 64-bit Windows.' }

        $asset = 'autotrack-win32-x64.zip'
        if ($env:AUTOTRACK_BUNDLE) {
            $src = $env:AUTOTRACK_BUNDLE
            $asset = ($src -split '[\\/]')[-1]
            $sums = $src.Substring(0, $src.Length - $asset.Length) + 'SHA256SUMS'
        } else {
            $src = "https://github.com/$Repo/releases/latest/download/$asset"
            $sums = "https://github.com/$Repo/releases/latest/download/SHA256SUMS"
        }

        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('autotrack-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        try {
            Say "Downloading $asset"
            $zip = Join-Path $tmp $asset
            Fetch $src $zip
            Fetch $sums (Join-Path $tmp 'SHA256SUMS')
            $want = $null
            foreach ($line in Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS')) {
                $f = $line.Trim() -split '\s+'
                if ($f.Count -ge 2 -and ($f[1] -eq $asset -or $f[1] -eq "*$asset")) { $want = $f[0].ToLower(); break }
            }
            if (-not $want) { Die "SHA256SUMS has no line for $asset" }
            $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
            if ($got -ne $want) { Die "checksum mismatch for ${asset}: got $got, want $want" }
            Say 'Checksum ok'

            # `check` unpacks into the temp dir and leaves the data dir alone.
            if ($step -eq 'check') {
                $new = Join-Path $tmp 'app.new'
            } else {
                New-Item -ItemType Directory -Force -Path $data | Out-Null
                New-Item -ItemType Directory -Force -Path $versions | Out-Null
                $new = Join-Path $versions 'new'
                if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }
            }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($zip, $new)
            Get-ChildItem -LiteralPath $new -Recurse -File | Unblock-File
            Quiet { & (Join-Path $new 'node\node.exe') (Join-Path $new 'install\setup.mjs') --check }
            if ($LASTEXITCODE -ne 0) {
                Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
                Die 'fix the code and run again'
            }
            if ($step -eq 'check') { return }

            # Stop the running one, and any browser host using the old node.exe.
            if ($autostart) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $node) {
                Quiet { & $node $cli stop *> $null }
            }
            $pidFile = Join-Path $data 'track.pid'
            for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $pidFile); $i++) {
                $old = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
                if (-not $old -or -not (Get-Process -Id $old -ErrorAction SilentlyContinue)) { break }
                Start-Sleep -Milliseconds 500
            }
            Get-Process -Name node -ErrorAction SilentlyContinue |
                Where-Object { $_.Path -and ($_.Path.StartsWith($app + '\', [StringComparison]::OrdinalIgnoreCase) -or $_.Path.StartsWith($versions + '\', [StringComparison]::OrdinalIgnoreCase)) } |
                Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300

            # versions\<v>, then point the app junction at it. An install before 0.3.0 left a real
            # app folder: it goes. A junction is removed as a link (never Remove-Item -Recurse on it).
            $version = (Get-Content -Raw -LiteralPath (Join-Path $new 'package.json') | ConvertFrom-Json).version
            if ($version -notmatch '^\d+\.\d+\.\d+') { Die "bad version in the bundle: $version" }
            $here = Join-Path $versions $version
            $item = Get-Item -LiteralPath $app -Force -ErrorAction SilentlyContinue
            if ($item -and $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                [IO.Directory]::Delete($app, $false)
            } elseif ($item) {
                $oldApp = Join-Path $data 'app.old'
                if (Test-Path -LiteralPath $oldApp) { Remove-Item -LiteralPath $oldApp -Recurse -Force }
                try { Move-Item -LiteralPath $app -Destination $oldApp } catch { Die "could not replace $app (in use?): $($_.Exception.Message)" }
                Remove-Item -LiteralPath $oldApp -Recurse -Force -ErrorAction SilentlyContinue
            }
            if (Test-Path -LiteralPath $here) {
                try { Remove-Item -LiteralPath $here -Recurse -Force } catch { Die "could not replace $here (in use?): $($_.Exception.Message)" }
            }
            Move-Item -LiteralPath $new -Destination $here
            New-Item -ItemType Junction -Path $app -Target $here | Out-Null
            # A fresh install starts clean: no pending rollback, other versions gone.
            Remove-Item -LiteralPath (Join-Path $data 'update.json') -Force -ErrorAction SilentlyContinue
            Get-ChildItem -LiteralPath $versions -Directory | Where-Object { $_.Name -ne $version } |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            Say "Installed $((Get-Content -LiteralPath (Join-Path $app 'VERSION')).Trim()) in $here"

            Quiet { & $node (Join-Path $app 'install\setup.mjs') }
            if ($LASTEXITCODE -ne 0) { Die 'setup failed' }
            # config.json holds the device's key: this user only. The ACL is rebuilt rather than edited
            # with icacls, which left SYSTEM and Administrators in on CI runners.
            $cfgPath = Join-Path $data 'config.json'
            try {
                $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
                $sec = Get-Acl -LiteralPath $cfgPath
                $sec.SetAccessRuleProtection($true, $false)
                foreach ($rule in @($sec.Access)) { [void]$sec.RemoveAccessRuleAll($rule) }
                $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
                Set-Acl -LiteralPath $cfgPath -AclObject $sec
                $left = @((Get-Acl -LiteralPath $cfgPath).Access)
                if ($left.Count -ne 1) { throw "$($left.Count) entries left" }
            } catch { Die "could not restrict config.json to this user: $($_.Exception.Message)" }

            # The browser extension, unpacked at a stable path (Chrome and Edge reload unpacked
            # extensions from it on restart). Replaced on update. The manifest's fixed key keeps the id.
            if (-not $StoreLive) {
                $extNew = Join-Path $data 'extension.new'
                $extOld = Join-Path $data 'extension.old'
                try {
                    foreach ($d in $extNew, $extOld) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }
                    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $app 'extension.zip'), $extNew)
                    if (-not (Test-Path -LiteralPath (Join-Path $extNew 'manifest.json'))) { throw 'manifest.json missing from extension.zip' }
                    if (Test-Path -LiteralPath $ext) { Move-Item -LiteralPath $ext -Destination $extOld }
                    Move-Item -LiteralPath $extNew -Destination $ext
                    if (Test-Path -LiteralPath $extOld) { Remove-Item -LiteralPath $extOld -Recurse -Force -ErrorAction SilentlyContinue }
                    Say "Extension unpacked in $ext"
                } catch {
                    Say "Warning: could not unpack the browser extension ($($_.Exception.Message)). The recorder works without it."
                    $ext = $null
                }
            }

            # `autotrack` on the command line (user PATH).
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $parts = @(if ($userPath) { $userPath -split ';' | Where-Object { $_ } })
            if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $app })) {
                [Environment]::SetEnvironmentVariable('Path', (($parts + $app) -join ';'), 'User')
            }
            if (-not (($env:Path -split ';') -contains $app)) { $env:Path = "$env:Path;$app" }

            # Hidden launcher, outside the versions so an update never touches it: wscript runs node
            # with no console window and waits. Exit 75 (an update or a rollback) starts it again at
            # once, a crash after 30 s, `autotrack stop` (exit 0) ends it. Like launchd KeepAlive.
            $q = { param($s) $s -replace '"', '""' }
            $lines = @('Set sh = CreateObject("WScript.Shell")')
            $lines += 'sh.Environment("PROCESS")("AUTOTRACK_SUPERVISED") = "1"'
            if ($env:AUTOTRACK_DIR) { $lines += 'sh.Environment("PROCESS")("AUTOTRACK_DIR") = "' + (& $q $data) + '"' }
            $lines += 'Do'
            $lines += '  rc = sh.Run("""' + (& $q $node) + '"" ""' + (& $q $cli) + '"" start", 0, True)'
            $lines += '  If rc = 0 Then Exit Do'
            $lines += '  If rc <> 75 Then WScript.Sleep 30000'
            $lines += 'Loop'
            $lines += 'WScript.Quit rc'
            Set-Content -LiteralPath $vbs -Value $lines -Encoding Unicode

            if (-not $autostart) {
                Say 'AUTOTRACK_NO_AUTOSTART set: no task registered, not started.'
            } else {
                # Per-user logon task, no admin. Fallback: the Run key.
                try {
                    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
                    $action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //Nologo `"$vbs`""
                    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
                    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
                        -MultipleInstances IgnoreNew
                    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
                    Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings `
                        -Principal $principal -Description 'autotrack recorder (wrenautomation/autotrack)' -Force | Out-Null
                    $registered = $true
                    Remove-ItemProperty -Path $RunKey -Name $Task -ErrorAction SilentlyContinue
                    Say "Login item: scheduled task '$Task'"
                } catch {
                    Set-ItemProperty -Path $RunKey -Name $Task -Value $launch
                    Say "Login item: Run key (task not allowed here: $($_.Exception.Message))"
                }
            }
        } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($doStart) {
        if (-not $autostart) {
            if ($step -eq 'start') { Say 'AUTOTRACK_NO_AUTOSTART set: not started.' }
        } else {
            if (-not (Test-Path -LiteralPath $node)) { Die "autotrack is not installed in $app" }
            if ($step -eq 'start') { $registered = [bool](Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) }
            if ($registered) { Start-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue }
            $up = $false
            for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 1; if (Running) { $up = $true; break } }
            if (-not $up) {
                Start-Process -FilePath $wscript -ArgumentList '//B', '//Nologo', "`"$vbs`""
                for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Seconds 1; if (Running) { $up = $true; break } }
            }
            if (-not $up) {
                $log = Join-Path $data 'track.log'
                if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 20 | ForEach-Object { Write-Host "  $_" } }
                Die "autotrack did not start; see $log"
            }
            Say 'Started'

            Say ''
            Say 'Checking (about 15 seconds)...'
            Quiet { & $node $cli doctor }
            Say ''
            Say 'autotrack is recording.'
            Say 'Pause or resume: Ctrl+Alt+Shift+P (a notification says which).'
            Say 'Status: autotrack status    Uninstall: autotrack uninstall   (new terminals; or run'
            Say "  `"$app\autotrack.cmd`" status)"
        }
    }

    if ($doExtension) {
        # Run on its own (the setup program's finish page), the folder is whatever install left.
        if ($step -eq 'extension' -and -not (Test-Path -LiteralPath (Join-Path $ext 'manifest.json'))) { $ext = $null }
        Extension-Help
    }
}
