import { rmSync } from 'node:fs';
import {
  acquireDaemonLock,
  createDaemonToken,
  fetchHealth,
  isPidAlive,
  readDaemonInfo,
  releaseDaemonLock,
  writeDaemonInfo,
} from './client.js';
import { listen, createApp, type ListeningServer } from './server.js';
import { BrowserSession } from '../session/browser.js';
import { daemonJsonPath, ensureHomeLayout, errorText, logDaemon, packageVersion } from '../config/paths.js';
import { readBuildFingerprint } from './build.js';

let ownsRuntime = false;
let shuttingDown = false;
let http: ListeningServer | undefined;
const session = new BrowserSession();

function cleanupFiles(): void {
  if (!ownsRuntime) return;
  try {
    rmSync(daemonJsonPath(), { force: true });
  } catch {
    // exit path
  }
  releaseDaemonLock();
}

function keepBrowserOnExit(closeBrowser = false): boolean {
  if (closeBrowser) return false;
  return process.env.RELAYWRIGHT_HEADLESS !== '1';
}

async function shutdown(reason: string, code = 0, closeBrowser = false): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logDaemon(`shutting down (${reason})`);
  await Promise.race([
    session.close({ keepBrowser: keepBrowserOnExit(closeBrowser) }).catch((err: unknown) => logDaemon(`browser close: ${errorText(err)}`)),
    new Promise((resolve) => setTimeout(resolve, 15_000)),
  ]);
  if (http) {
    await http.close().catch((err: unknown) => logDaemon(`server close: ${errorText(err)}`));
  }
  cleanupFiles();
  ownsRuntime = false;
  process.exit(code);
}

async function main(): Promise<void> {
  ensureHomeLayout();
  logDaemon(`process start pid=${process.pid}`);

  if (!acquireDaemonLock()) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const info = readDaemonInfo();
      if (info && info.pid !== process.pid && isPidAlive(info.pid) && (await fetchHealth(info))) {
        logDaemon(`another daemon is ready pid=${info.pid} port=${info.port}`);
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    logDaemon('another daemon holds the lock but did not become healthy');
    process.exit(1);
  }
  ownsRuntime = true;
  process.on('exit', cleanupFiles);
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const existing = readDaemonInfo();
  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid) && (await fetchHealth(existing))) {
    logDaemon(`already running pid=${existing.pid}; releasing lock`);
    ownsRuntime = false;
    releaseDaemonLock();
    process.exit(0);
  }

  const token = createDaemonToken();
  const build = readBuildFingerprint();
  // Listen and publish daemon.json before the browser launches. A Chrome for Testing
  // download can take longer than the client's health timeout.
  http = await listen(
    createApp({
      token,
      session,
      build,
      onShutdown: (closeBrowser) => {
        void shutdown('http', 0, closeBrowser === true);
      },
    }),
  );
  await writeDaemonInfo({
    pid: process.pid,
    port: http.port,
    token,
    startedAt: new Date().toISOString(),
    version: packageVersion(),
    build,
  });
  logDaemon(`ready port=${http.port}`);
  session.warmUp();
}

process.on('unhandledRejection', (err) => {
  logDaemon(`unhandledRejection: ${errorText(err)}`);
});

process.on('uncaughtException', (err) => {
  logDaemon(`uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  void shutdown('uncaughtException', 1);
});

main().catch((err: unknown) => {
  logDaemon(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  void session.close({ keepBrowser: keepBrowserOnExit(false) }).catch(() => undefined).finally(() => {
    cleanupFiles();
    ownsRuntime = false;
    process.exit(1);
  });
});
