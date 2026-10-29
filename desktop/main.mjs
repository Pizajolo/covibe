// covibe for macOS: an Electron shell around the local covibe server and UI.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, systemPreferences } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
let server;
let win;
let quitting = false;

// Apps started from Finder get a minimal PATH (/usr/bin:/bin...). Agents need
// the user's real one for git, node, package managers and test runners.
function loadLoginPath() {
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')];
  let fromShell = '';
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    fromShell = execFileSync(sh, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).split('__PATH__').pop() ?? '';
  } catch {
    // keep the fallback
  }
  const parts = [...fromShell.split(':'), ...(process.env.PATH ?? '').split(':'), ...fallback].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(':');
}

async function start() {
  loadLoginPath();
  // The engine is ESM compiled to dist/; the UI is served by the same server.
  const { startServer } = await import(join(here, '..', 'dist', 'server', 'app.js'));
  // Members' browsers run in Electron's own Chromium (offscreen windows), so nothing needs installing.
  const { electronProvider } = await import(join(here, '..', 'dist', 'browser', 'electron.js'));
  server = await startServer({ uiDir: join(here, '..', 'dist-ui'), browser: electronProvider({ BrowserWindow, session }) });
  allowMicrophone(new URL(server.url).origin);
  createWindow();
}

// The mic button (voice input) records in covibe's own page. Only that page
// may use the microphone, never a web page shown inside it (a run's preview);
// macOS asks you once and remembers the answer. Other permissions stay as
// Electron grants them (notifications).
function allowMicrophone(origin) {
  const ours = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission !== 'media') return callback(true);
    const audioOnly = (details.mediaTypes ?? []).every((t) => t === 'audio');
    if (!audioOnly || !details.isMainFrame || !ours(details.requestingUrl)) return callback(false);
    if (process.platform !== 'darwin') return callback(true);
    systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission !== 'media') return true;
    return details.isMainFrame !== false && ours(requestingOrigin) && details.mediaType !== 'video';
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: 'covibe',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  const origin = new URL(server.url).origin;
  // Links to other sites open in the browser; the window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  void win.loadURL(server.url);
  win.on('closed', () => {
    win = undefined;
  });
}

ipcMain.handle('covibe:pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add a project',
    message: 'Choose a git repository for your teams to work on',
    buttonLabel: 'Add Project',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : (res.filePaths[0] ?? null);
});
ipcMain.handle('covibe:reveal', (_e, p) => {
  if (typeof p === 'string' && existsSync(p)) shell.showItemInFolder(p);
});
ipcMain.handle('covibe:open-path', async (_e, p) => {
  if (typeof p === 'string' && existsSync(p)) await shell.openPath(p);
});
// Clicking a system notification brings the window back to the front.
ipcMain.handle('covibe:focus', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
});
ipcMain.handle('covibe:open-external', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url);
});

function sendKey(key) {
  win?.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, metaKey: true }))`).catch(() => undefined);
}

function buildMenu() {
  const go = (hash) => win?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => undefined);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'File',
        submenu: [
          { label: 'New Goal…', accelerator: 'CmdOrCtrl+N', click: () => sendKey('n') },
          { type: 'separator' },
          { label: 'Add Project…', click: () => go('#/projects') },
          { label: 'New Team…', click: () => go('#/teams') },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'Go',
        submenu: [
          { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => go('#/') },
          { label: 'Runs', accelerator: 'CmdOrCtrl+2', click: () => go('#/runs') },
          { label: 'Teams', accelerator: 'CmdOrCtrl+3', click: () => go('#/teams') },
          { label: 'Projects', accelerator: 'CmdOrCtrl+4', click: () => go('#/projects') },
          { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => go('#/settings') },
          { type: 'separator' },
          { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => win?.webContents.navigationHistory.goBack() },
          { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => win?.webContents.navigationHistory.goForward() },
        ],
      },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [{ label: 'Claude Agent SDK docs', click: () => shell.openExternal('https://docs.claude.com/en/api/agent-sdk/overview') }],
      },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.setName('covibe');
nativeTheme.themeSource = 'system';
app.whenReady().then(async () => {
  buildMenu();
  try {
    await start();
  } catch (err) {
    dialog.showErrorBox('covibe could not start', String(err?.stack ?? err));
    app.quit();
  }
});

app.on('activate', () => {
  if (!win && server) createWindow();
});

// The window can close while teams keep working; quitting stops them, so ask first.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  let live = 0;
  try {
    const res = await fetch(new URL('/api/runs?limit=200', server.url), { headers: { authorization: `Bearer ${server.token}` } });
    live = (await res.json()).filter((r) => r.status === 'running').length;
  } catch {
    // quit anyway
  }
  if (live) {
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'warning',
      buttons: ['Keep Working', 'Stop and Quit'],
      defaultId: 0,
      cancelId: 0,
      message: `${live} run${live > 1 ? 's are' : ' is'} still working`,
      detail: 'Quitting stops them. Work merged so far stays on each run’s branch.',
    });
    if (response === 0) return;
  }
  quitting = true;
  await server.close().catch(() => undefined);
  app.quit();
});
