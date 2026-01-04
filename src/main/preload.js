const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  expandFolder: (path) => ipcRenderer.invoke('expand-folder', path),
  getFolderContents: (path) => ipcRenderer.invoke('get-folder-contents', path),
  getRecentFiles: () => ipcRenderer.invoke('get-recent-files'),
  search: (query) => ipcRenderer.invoke('search', query),
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  showInFinder: (path) => ipcRenderer.invoke('show-in-finder', path)
});
