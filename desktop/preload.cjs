// Bridge between the UI and the Mac app. The page runs sandboxed with context
// isolation; this is the only native surface it gets.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('covibe', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('covibe:pick-folder'),
  reveal: (path) => ipcRenderer.invoke('covibe:reveal', path),
  openPath: (path) => ipcRenderer.invoke('covibe:open-path', path),
  openExternal: (url) => ipcRenderer.invoke('covibe:open-external', url),
  focus: () => ipcRenderer.invoke('covibe:focus'),
});
