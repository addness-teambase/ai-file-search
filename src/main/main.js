const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { init, expandFolder, getFolderContents, getRecentFiles, searchFiles, suggestOrganization, executeOrganization, startWatching, stopWatching, processChat } = require('./indexer');

let mainWindow = null;
let currentWatchedFolder = null;
const fs = require('fs');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // ファイル監視を開始
  startWatching((change) => {
    // レンダラーに変更を通知
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-changed', change);
    }
  });
}

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  stopWatching();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC
ipcMain.handle('init', () => init());
ipcMain.handle('expand-folder', (e, path) => expandFolder(path));
ipcMain.handle('get-folder-contents', (e, path) => getFolderContents(path));
ipcMain.handle('get-recent-files', () => getRecentFiles());
ipcMain.handle('search', async (e, query) => searchFiles(query));
ipcMain.handle('open-file', (e, filePath) => shell.openPath(filePath));
ipcMain.handle('show-in-finder', (e, filePath) => shell.showItemInFolder(filePath));
ipcMain.handle('suggest-organization', async (e, folderPath) => suggestOrganization(folderPath));
ipcMain.handle('execute-organization', async (e, actions) => executeOrganization(actions));
ipcMain.handle('process-chat', async (e, message, currentFolder) => processChat(message, currentFolder));
