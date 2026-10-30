import { spawn } from 'node:child_process';
import { errorText, logDaemon } from './config/paths.js';
import { readGlobalConfig } from './privacy/store.js';
const NOTIFY_MS = 5_000;
/** Constant script. User text arrives only as RW_NOTIFY_XML. */
export const WINDOWS_NOTIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$xmlText = [Environment]::GetEnvironmentVariable('RW_NOTIFY_XML')
if ([string]::IsNullOrEmpty($xmlText)) { return }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
[System.Media.SystemSounds]::Exclamation.Play()
Start-Sleep -Milliseconds 400
`;
export function windowsToastXml(input) {
    const lines = [input.title, input.body];
    const detail = input.detail?.trim();
    if (detail)
        lines.push(detail);
    const texts = lines.map((line) => `<text>${xmlText(line)}</text>`).join('');
    return `<toast duration="long"><visual><binding template="ToastGeneric">${texts}</binding></visual></toast>`;
}
function xmlText(value) {
    return value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r\n|\r|\n/g, '&#10;');
}
/** Best-effort desktop notification. Never throws. Disabled when RELAYWRIGHT_NOTIFY=0. */
export function notify(title, body, detail) {
    if (process.env.RELAYWRIGHT_NOTIFY === '0')
        return;
    try {
        if (readGlobalConfig().notify === false)
            return;
        if (process.platform === 'win32')
            notifyWindows(title, body, detail);
        else if (process.platform === 'darwin')
            notifyMac(title, body, detail);
        else
            notifyLinux(title, body, detail);
    }
    catch (err) {
        logDaemon(`notify failed: ${errorText(err)}`);
    }
}
function notifyWindows(title, body, detail) {
    const encoded = Buffer.from(WINDOWS_NOTIFY_SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, RW_NOTIFY_XML: windowsToastXml({ title, body, detail }) },
    });
    watch(child);
}
function notifyMac(title, body, detail) {
    const child = spawn('osascript', ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run', title, joined(body, detail)], { stdio: 'ignore' });
    watch(child);
}
function notifyLinux(title, body, detail) {
    const child = spawn('notify-send', ['--', title, joined(body, detail)], { stdio: 'ignore' });
    watch(child);
}
function joined(body, detail) {
    const extra = detail?.trim();
    return extra ? `${body}\n${extra}` : body;
}
function watch(child) {
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
//# sourceMappingURL=notify.js.map