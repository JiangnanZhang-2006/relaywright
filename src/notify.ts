import { spawn } from 'node:child_process';
import { errorText, logDaemon } from './config/paths.js';

const NOTIFY_MS = 5_000;

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$title = [Environment]::GetEnvironmentVariable('RW_NOTIFY_TITLE')
$body = [Environment]::GetEnvironmentVariable('RW_NOTIFY_BODY')
if ($null -eq $title) { $title = '' }
if ($null -eq $body) { $body = '' }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$nodes = $xml.GetElementsByTagName('text')
[void]$nodes.Item(0).AppendChild($xml.CreateTextNode($title))
[void]$nodes.Item(1).AppendChild($xml.CreateTextNode($body))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
[System.Media.SystemSounds]::Exclamation.Play()
Start-Sleep -Milliseconds 400
`;

/** Best-effort desktop notification. Never throws. Disabled when RELAYWRIGHT_NOTIFY=0. */
export function notify(title: string, body: string): void {
  if (process.env.RELAYWRIGHT_NOTIFY === '0') return;
  try {
    if (process.platform === 'win32') notifyWindows(title, body);
    else if (process.platform === 'darwin') notifyMac(title, body);
    else notifyLinux(title, body);
  } catch (err) {
    logDaemon(`notify failed: ${errorText(err)}`);
  }
}

function notifyWindows(title: string, body: string): void {
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, RW_NOTIFY_TITLE: title, RW_NOTIFY_BODY: body },
  });
  watch(child);
}

function notifyMac(title: string, body: string): void {
  const child = spawn(
    'osascript',
    ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run', title, body],
    { stdio: 'ignore' },
  );
  watch(child);
}

function notifyLinux(title: string, body: string): void {
  const child = spawn('notify-send', ['--', title, body], { stdio: 'ignore' });
  watch(child);
}

function watch(child: ReturnType<typeof spawn>): void {
  const timer = setTimeout(() => {
    child.kill();
  }, NOTIFY_MS);
  timer.unref?.();
  child.on('error', () => {
    clearTimeout(timer);
  });
  child.on('exit', () => {
    clearTimeout(timer);
  });
  child.unref();
}
