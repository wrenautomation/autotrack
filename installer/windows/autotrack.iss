; autotrack setup program (Inno Setup 6). Built by installer\windows\build.ps1, which passes:
;   /DAppVersion=<package.json version>  /DNumericVersion=a.b.c.d  /DStageDir=<folder>  /DOutDir=<folder>
; StageDir holds the Windows bundle, a SHA256SUMS for it, install.ps1 and run.ps1.
;
; The setup program installs nothing itself. It carries the bundle, asks for the install code, and
; runs install.ps1 (the same file as the one-line install) against the bundled files, one step at a
; time: check (the code), install, then start and extension from the finish page.
;
; Silent (CI, deployment):
;   autotrack-setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CODE=<install code>
; or put the code in the AUTOTRACK environment variable (kept out of Inno's /LOG, which records the
; command line). No code, or a bad one: Setup exits non-zero before it changes anything.
#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0.0"
#endif
#ifndef StageDir
  #error Pass /DStageDir=<folder>
#endif
#ifndef OutDir
  #define OutDir "out"
#endif

[Setup]
AppId={{7C0E5B94-2F6A-4D1B-8E37-A94C51D0B6F2}
AppName=autotrack
AppVersion={#AppVersion}
AppVerName=autotrack {#AppVersion}
AppPublisher=Wren Automation
AppPublisherURL=https://github.com/wrenautomation/autotrack
AppSupportURL=https://github.com/wrenautomation/autotrack/issues
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=autotrack
VersionInfoDescription=autotrack setup
; Only the uninstaller lives here. The app and its data are in %LOCALAPPDATA%\autotrack (install.ps1),
; a different folder, so `autotrack uninstall` never deletes the uninstaller under its own feet.
DefaultDirName={autopf}\autotrack
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=autotrack-setup-{#AppVersion}
; The bundle is already a zip: compressing it again gains nothing.
Compression=none
SolidCompression=no
WizardStyle=modern
UninstallDisplayName=autotrack
CloseApplications=no
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#StageDir}\autotrack-win32-x64.zip"; Flags: dontcopy
Source: "{#StageDir}\SHA256SUMS"; Flags: dontcopy
Source: "{#StageDir}\install.ps1"; Flags: dontcopy
Source: "{#StageDir}\run.ps1"; Flags: dontcopy

; The finish page's two boxes. Each runs install.ps1 for one step, in a console that waits for a key.
[Run]
Filename: "{cmd}"; Parameters: "/d /s /c """"{sys}\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -ExecutionPolicy Bypass -File ""{tmp}\run.ps1"" & echo. & pause"""; BeforeInstall: UseStartStep; Description: "Start tracking now"; Flags: postinstall skipifsilent; Check: StartWanted
Filename: "{cmd}"; Parameters: "/d /s /c """"{sys}\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -ExecutionPolicy Bypass -File ""{tmp}\run.ps1"" & echo. & pause"""; BeforeInstall: UseExtensionStep; Description: "Show the browser extension steps (opens Chrome or Edge)"; Flags: postinstall skipifsilent

; Add/Remove Programs: stop the recorder, ship what is left, remove the login item, the browser
; hookup and the app. The detached cleanup finishes a few seconds after this returns.
[UninstallRun]
Filename: "{cmd}"; Parameters: "/d /s /c """"{localappdata}\autotrack\app\autotrack.cmd"" uninstall --yes"""; Flags: runhidden waituntilterminated; RunOnceId: "AutotrackUninstall"; Check: AppInstalled

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
var
  CodePage: TInputQueryWizardPage;
  Code: String;          // the install code, once it checked out
  InitialCode: String;   // from /CODE= or the AUTOTRACK environment variable
  Extracted: Boolean;

function SetEnvironmentVariable(lpName, lpValue: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function GetCodeParam(): String;
begin
  Result := Trim(ExpandConstant('{param:CODE|}'));
  if Result = '' then
    Result := Trim(GetEnv('AUTOTRACK'));
end;

function LooksLikeCode(const S: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := Length(S) > 0;
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if not (((C >= 'A') and (C <= 'Z')) or ((C >= 'a') and (C <= 'z')) or
            ((C >= '0') and (C <= '9')) or (C = '-') or (C = '_')) then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

function LogOf(const Step: String): String;
begin
  Result := ExpandConstant('{tmp}\autotrack-' + Step + '.log');
end;

// The last few lines install.ps1 printed, for a message box.
function LogTail(const Step: String): String;
var
  Lines: TArrayOfString;
  I, First: Integer;
begin
  Result := '';
  if not LoadStringsFromFile(LogOf(Step), Lines) then
    Exit;
  First := GetArrayLength(Lines) - 4;
  if First < 0 then
    First := 0;
  for I := First to GetArrayLength(Lines) - 1 do
    if Trim(Lines[I]) <> '' then
      Result := Result + Trim(Lines[I]) + #13#10;
end;

procedure Extract();
begin
  if Extracted then
    Exit;
  ExtractTemporaryFile('autotrack-win32-x64.zip');
  ExtractTemporaryFile('SHA256SUMS');
  ExtractTemporaryFile('install.ps1');
  ExtractTemporaryFile('run.ps1');
  Extracted := True;
end;

// Runs install.ps1 for one step (output to a log in the setup's temp folder). The code goes in the
// environment, never on a command line.
function RunStep(const Step: String): Integer;
var
  Rc: Integer;
begin
  Extract();
  SetEnvironmentVariable('AUTOTRACK_STEP', Step);
  SetEnvironmentVariable('AUTOTRACK_BUNDLE', ExpandConstant('{tmp}\autotrack-win32-x64.zip'));
  if not Exec(ExpandConstant('{cmd}'),
      '/d /s /c ""' + ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe') +
      '" -NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\run.ps1') +
      '" > "' + LogOf(Step) + '" 2>&1"',
      '', SW_HIDE, ewWaitUntilTerminated, Rc) then
    Rc := -1;
  Result := Rc;
end;

// '' when the code is good; else what to tell the person.
function CheckCode(const Value: String): String;
begin
  Result := '';
  if Value = '' then
  begin
    Result := 'Paste your install code. "autobrowse autotrack enroll <device>" prints it.';
    Exit;
  end;
  if not LooksLikeCode(Value) then
  begin
    Result := 'That is not an install code. Copy the whole code, with no spaces.';
    Exit;
  end;
  SetEnvironmentVariable('AUTOTRACK', Value);
  try
    if RunStep('check') <> 0 then
      Result := 'The install code did not check out.' + #13#10#13#10 + LogTail('check');
  finally
    SetEnvironmentVariable('AUTOTRACK', '');
  end;
end;

procedure InitializeWizard();
begin
  if not WizardSilent then
    InitialCode := GetCodeParam();
  CodePage := CreateInputQueryPage(wpWelcome, 'Install code',
    'Paste the install code for this computer.',
    'The code ties this computer to its upload bucket. autotrack installs for you only; no administrator rights are needed.');
  CodePage.Add('Install code:', False);
  CodePage.Values[0] := InitialCode;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Err: String;
  Busy: TOutputMarqueeProgressWizardPage;
begin
  Result := True;
  if WizardSilent then
    Exit;
  if CurPageID = CodePage.ID then
  begin
    Busy := CreateOutputMarqueeProgressPage('Checking the code', 'Checking the install code...');
    Busy.Show;
    try
      Err := CheckCode(Trim(CodePage.Values[0]));
    finally
      Busy.Hide;
    end;
    if Err <> '' then
    begin
      MsgBox(Err, mbError, MB_OK);
      Result := False;
    end
    else
      Code := Trim(CodePage.Values[0]);
  end;
end;

// A silent install never shows the code page, so the code is checked here, first. Setup shows
// PrepareToInstall and NextButtonClick errors in a plain box that /SUPPRESSMSGBOXES does not
// answer (it hung CI). SuppressibleMsgBox is answered, and False exits Setup (code 1) with
// nothing installed.
function InitializeSetup(): Boolean;
var
  Err: String;
begin
  Result := True;
  if not WizardSilent then
    Exit;
  InitialCode := GetCodeParam();
  Err := CheckCode(InitialCode);
  if Err <> '' then
  begin
    Log('Install code refused: ' + Err);
    SuppressibleMsgBox(Err, mbError, MB_OK, IDOK);
    Result := False;
  end
  else
    Code := InitialCode;
end;

// Tell the person (or, silent, the log), then end Setup. Abort exits Setup from ssInstall.
procedure StopSetup(const Msg: String);
begin
  Log(Msg);
  SuppressibleMsgBox(Msg, mbError, MB_OK, IDOK);
  Abort;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Rc: Integer;
begin
  if CurStep <> ssInstall then
    Exit;
  WizardForm.StatusLabel.Caption := 'Installing autotrack (about a minute)...';
  WizardForm.FilenameLabel.Caption := '';
  if WizardSilent then
    SetEnvironmentVariable('AUTOTRACK_NO_BROWSER', '1');
  SetEnvironmentVariable('AUTOTRACK', Code);
  try
    Rc := RunStep('install');
  finally
    SetEnvironmentVariable('AUTOTRACK', '');
  end;
  if Rc <> 0 then
    StopSetup('autotrack could not be installed.' + #13#10#13#10 + LogTail('install'));
  // A silent install starts it too, unless AUTOTRACK_NO_AUTOSTART is set. Not fatal: the login item is in.
  if WizardSilent and (GetEnv('AUTOTRACK_NO_AUTOSTART') = '') then
    RunStep('start');
  ForceDirectories(ExpandConstant('{app}'));
  FileCopy(LogOf('install'), ExpandConstant('{app}\install.log'), False);
end;

procedure UseStartStep();
begin
  SetEnvironmentVariable('AUTOTRACK_STEP', 'start');
end;

procedure UseExtensionStep();
begin
  SetEnvironmentVariable('AUTOTRACK_STEP', 'extension');
end;

function StartWanted(): Boolean;
begin
  Result := GetEnv('AUTOTRACK_NO_AUTOSTART') = '';
end;

function AppInstalled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\autotrack\app\autotrack.cmd'));
end;
