import { app, BrowserWindow, dialog } from 'electron';
import { startServer } from '../server/server.js';
import { join } from 'node:path';

let server;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    try {
      const engineOptions = app.isPackaged
        ? { executablePath: join(process.resourcesPath, 'pikafish', 'pikafish.exe') } : undefined;
      try { server = await startServer({ engineOptions }); }
      catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        server = await startServer({ port: 0, engineOptions });
      }
      const window = new BrowserWindow({
        width: 1100, height: 880, minWidth: 580, minHeight: 680,
        title: '中国象棋 Demo', autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      const origin = `http://127.0.0.1:${server.port}`;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== origin) event.preventDefault();
      });
      await window.loadURL(origin);
    } catch (error) {
      dialog.showErrorBox('无法启动象棋', error.message);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!server || quitting) return;
    event.preventDefault();
    quitting = true;
    void server.close().then(() => app.quit(), () => app.quit());
  });
}
