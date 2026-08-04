import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, cp, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const appIcon = path.join(appRoot, 'assets', process.platform === 'darwin' ? 'app-icon.icns' : 'app-icon.png');

let mainWindow = null;
let platformServer = null;

async function exists(candidate) {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function configureDesktopDataDir() {
  if (process.env.PR_MONITOR_DATA_DIR) return;
  if (!app.isPackaged) return;

  const dataDir = path.join(app.getPath('userData'), 'data');
  const bundledDataDir = path.join(appRoot, 'data');
  process.env.PR_MONITOR_DATA_DIR = dataDir;
  await mkdir(dataDir, { recursive: true });

  const hasStore = await exists(path.join(dataDir, 'store.json'));
  const hasStorageConfig = await exists(path.join(dataDir, 'storage-config.json'));
  if ((!hasStore || !hasStorageConfig) && await exists(bundledDataDir)) {
    await cp(bundledDataDir, dataDir, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }
}

async function configureBundledSkill() {
  if (process.env.BITBUCKET_PR_REVIEW_SKILL_DIR) return;

  const bundledSkillDir = app.isPackaged
    ? path.join(process.resourcesPath, 'skills', 'bitbucket-pr-review')
    : path.join(appRoot, 'app-resources', 'skills', 'bitbucket-pr-review');
  const targetSkillDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'skills', 'bitbucket-pr-review')
    : bundledSkillDir;

  if (app.isPackaged && await exists(path.join(bundledSkillDir, 'SKILL.md'))) {
    await mkdir(path.dirname(targetSkillDir), { recursive: true });
    await cp(bundledSkillDir, targetSkillDir, {
      recursive: true,
      force: true,
      errorOnExist: false
    });
  }

  process.env.BITBUCKET_PR_REVIEW_SKILL_DIR = targetSkillDir;
}

async function startPlatform() {
  await configureDesktopDataDir();
  await configureBundledSkill();
  const { startServer } = await import('../server.mjs');
  platformServer = await startServer({ port: 0, host: '127.0.0.1' });
  return `http://${platformServer.host}:${platformServer.port}/`;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 760,
    minHeight: 560,
    title: 'PR Monitor',
    icon: appIcon,
    backgroundColor: '#f8f5ec',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installContextMenu(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//.test(targetUrl) && !targetUrl.startsWith(url)) {
      shell.openExternal(targetUrl);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (/^https?:\/\//.test(targetUrl) && !targetUrl.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (!modifier || input.type !== 'keyDown') return;
    if (input.key.toLowerCase() === 'r') {
      event.preventDefault();
      mainWindow.reload();
    }
    if (input.key.toLowerCase() === 'i' && input.alt) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.loadURL(url);
}

function installContextMenu(window) {
  window.webContents.on('context-menu', (event, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'delete', enabled: params.editFlags.canDelete },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll }
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy' });
    }
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [
                  { role: 'startSpeaking' },
                  { role: 'stopSpeaking' }
                ]
              }
            ]
          : [
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' }
            ])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ]));
}

app.whenReady().then(async () => {
  app.setName('PR Monitor');
  installMenu();
  const url = await startPlatform();
  createWindow(url);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && platformServer) {
    createWindow(`http://${platformServer.host}:${platformServer.port}/`);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  platformServer?.server?.close();
});
