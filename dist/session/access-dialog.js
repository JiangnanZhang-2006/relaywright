import { spawn } from 'node:child_process';
import { errorText, logDaemon } from '../config/paths.js';
const DIALOG_MS = 60_000;
/**
 * Constant script. The domain and reason arrive only as RW_ACCESS_DOMAIN and
 * RW_ACCESS_REASON so a quote in either cannot change the script.
 */
export const WINDOWS_ACCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$domain = [Environment]::GetEnvironmentVariable('RW_ACCESS_DOMAIN')
$reason = [Environment]::GetEnvironmentVariable('RW_ACCESS_REASON')
if ([string]::IsNullOrEmpty($domain)) { Write-Output 'deny'; return }
$form = New-Object System.Windows.Forms.Form
$form.Text = 'relaywright'
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(460, 200)
$label = New-Object System.Windows.Forms.Label
$label.AutoSize = $false
$label.Size = New-Object System.Drawing.Size(440, 110)
$label.Location = New-Object System.Drawing.Point(10, 10)
$label.Text = "$domain\`r\`n$reason"
$once = New-Object System.Windows.Forms.Button
$once.Text = '本次允许'
$once.DialogResult = [System.Windows.Forms.DialogResult]::Yes
$once.Location = New-Object System.Drawing.Point(10, 150)
$once.Size = New-Object System.Drawing.Size(110, 32)
$always = New-Object System.Windows.Forms.Button
$always.Text = '始终允许'
$always.DialogResult = [System.Windows.Forms.DialogResult]::OK
$always.Location = New-Object System.Drawing.Point(130, 150)
$always.Size = New-Object System.Drawing.Size(110, 32)
$deny = New-Object System.Windows.Forms.Button
$deny.Text = '拒绝'
$deny.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$deny.Location = New-Object System.Drawing.Point(250, 150)
$deny.Size = New-Object System.Drawing.Size(110, 32)
$form.Controls.Add($label)
$form.Controls.Add($once)
$form.Controls.Add($always)
$form.Controls.Add($deny)
$form.CancelButton = $deny
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
$result = $form.ShowDialog()
$timer.Stop()
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { Write-Output 'once' }
elseif ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output 'always' }
else { Write-Output 'deny' }
`;
export const MAC_ACCESS_SCRIPT = `
on run argv
  set domainName to item 1 of argv
  set why to item 2 of argv
  try
    set choice to display dialog (domainName & return & why) buttons {"拒绝", "本次允许", "始终允许"} default button "拒绝" with title "relaywright" giving up after 60
    if gave up of choice then return "deny"
    set picked to button returned of choice
    if picked is "本次允许" then return "once"
    if picked is "始终允许" then return "always"
    return "deny"
  on error
    return "deny"
  end try
end run
`;
const REASON_MAX_CHARS = 200;
const REASON_MAX_LINES = 4;
let loggedIgnoredDecision = false;
/** Test-only switches are inert unless this process was started by the test harness. */
export function testOverridesEnabled(env = process.env) {
    if (env.NODE_ENV === 'test')
        return true;
    const vitest = env.VITEST;
    return typeof vitest === 'string' && vitest.length > 0;
}
/** One line, no control characters, so the domain cannot be pushed off the dialog. */
export function sanitizeAccessDomain(domain) {
    return domain
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** Drop control characters, then keep at most four lines and 200 characters. */
export function sanitizeAccessReason(reason) {
    const normalized = reason.replace(/\r\n|\r|\u2028|\u2029/g, '\n');
    const stripped = normalized.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
    const lines = stripped
        .split('\n')
        .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .slice(0, REASON_MAX_LINES);
    const text = lines.join('\n');
    return [...text].slice(0, REASON_MAX_CHARS).join('');
}
/** Domain first, then the shortened reason. Zenity must be passed this with --no-markup. */
export function accessDialogBody(domain, reason) {
    const host = sanitizeAccessDomain(domain);
    const why = sanitizeAccessReason(reason);
    return why ? `${host}\n${why}` : host;
}
export function linuxDialogArgs(domain, reason) {
    return [
        '--question',
        '--no-markup',
        '--title=relaywright',
        '--text',
        accessDialogBody(domain, reason),
        '--ok-label=本次允许',
        '--cancel-label=拒绝',
        '--extra-button=始终允许',
        '--timeout=60',
    ];
}
/** The dialog never approves itself. Tests set RELAYWRIGHT_TEST_ACCESS_DECISION. */
export function presetAccessDecision() {
    const value = process.env.RELAYWRIGHT_TEST_ACCESS_DECISION;
    if (value === 'once' || value === 'always' || value === 'deny') {
        if (testOverridesEnabled())
            return value;
        if (!loggedIgnoredDecision) {
            loggedIgnoredDecision = true;
            logDaemon('ignoring RELAYWRIGHT_TEST_ACCESS_DECISION outside tests');
        }
    }
    if (process.env.RELAYWRIGHT_NOTIFY === '0')
        return 'deny';
    return null;
}
export async function askAccess(domain, reason) {
    const preset = presetAccessDecision();
    if (preset)
        return preset;
    const host = sanitizeAccessDomain(domain);
    const why = sanitizeAccessReason(reason);
    if (!host)
        return 'deny';
    try {
        if (process.platform === 'win32')
            return await askWindows(host, why);
        if (process.platform === 'darwin')
            return await askMac(host, why);
        return await askLinux(host, why);
    }
    catch (err) {
        logDaemon(`access dialog failed: ${errorText(err)}`);
        return 'deny';
    }
}
function askWindows(domain, reason) {
    const encoded = Buffer.from(WINDOWS_ACCESS_SCRIPT, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-Sta', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, RW_ACCESS_DOMAIN: domain, RW_ACCESS_REASON: reason },
    });
    return readChild(child, DIALOG_MS + 5_000);
}
function askMac(domain, reason) {
    const child = spawn('osascript', ['-e', MAC_ACCESS_SCRIPT, domain, reason], { stdio: ['ignore', 'pipe', 'ignore'] });
    return readChild(child, DIALOG_MS + 5_000);
}
async function askLinux(domain, reason) {
    const child = spawn('zenity', linuxDialogArgs(domain, reason), { stdio: ['ignore', 'pipe', 'ignore'] });
    const outcome = await readChildRaw(child, DIALOG_MS + 5_000);
    if (outcome.stdout.includes('始终允许'))
        return 'always';
    if (outcome.code === 0)
        return 'once';
    if (outcome.error)
        logDaemon('zenity is not installed; access request denied');
    return 'deny';
}
function readChild(child, timeoutMs) {
    return readChildRaw(child, timeoutMs).then((outcome) => parseDecision(outcome.stdout));
}
function readChildRaw(child, timeoutMs) {
    return new Promise((resolve) => {
        let stdout = '';
        let error = false;
        const timer = setTimeout(() => {
            child.kill();
            resolve({ code: null, stdout, error: true });
        }, timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            stdout += chunk;
        });
        child.on('error', () => {
            error = true;
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, error });
        });
    });
}
export function parseDecision(stdout) {
    const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line === 'once' || line === 'always' || line === 'deny');
    return lines.at(-1) ?? 'deny';
}
//# sourceMappingURL=access-dialog.js.map