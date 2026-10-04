import { app, BrowserWindow, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../src/shared/types';

const RELEASES_API = 'https://api.github.com/repos/BoazCohenJ/Cutcast/releases/latest';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let status: UpdateStatus = { state: 'idle' };

function publish(next: UpdateStatus) {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('update:status', status);
  }
}

export const updateStatus = () => status;

/** The portable exe runs from a temp folder and can't replace itself, so it only learns about new versions. */
const isPortable = () => Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

function isNewer(latest: string, current: string) {
  const parse = (version: string) => version.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0);
    }
  }
  return false;
}

async function checkPortable() {
  const response = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) {
    return;
  }
  const release = (await response.json()) as { tag_name: string; html_url: string };
  if (isNewer(release.tag_name, app.getVersion())) {
    publish({ state: 'available', version: release.tag_name.replace(/^v/, ''), url: release.html_url });
  }
}

function check() {
  if (isPortable()) {
    void checkPortable().catch(() => undefined);
  } else if (status.state !== 'ready') {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }
}

/** Downloads new releases in the background; they install on the next restart, or right away if the user asks. */
export function startUpdater() {
  if (!app.isPackaged) {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => publish({ state: 'downloading', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => publish({ state: 'ready', version: info.version }));
  autoUpdater.on('error', () => {
    if (status.state === 'downloading') {
      publish({ state: 'idle' });
    }
  });

  check();
  setInterval(check, CHECK_INTERVAL_MS);
}

export function installUpdate() {
  if (status.state === 'ready') {
    // Silent install, then relaunch the new version.
    autoUpdater.quitAndInstall(true, true);
  }
}
