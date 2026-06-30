import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopApi', {
  openMediaFiles: () => ipcRenderer.invoke('dialog:openMediaFiles'),
  chooseSaveFile: () => ipcRenderer.invoke('dialog:chooseSaveFile'),
  exportProject: (payload: unknown) => ipcRenderer.invoke('project:export', payload),
  showHelp: () => ipcRenderer.invoke('dialog:help')
});
