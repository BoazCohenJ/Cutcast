import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { ExportProgress, ExportRequest, MediaAnalysis, Project } from '../src/shared/types';

function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void) {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const desktopApi = {
  openMedia: (): Promise<string[]> => ipcRenderer.invoke('dialog:openMedia'),
  chooseExportPath: (suggestedName: string): Promise<string | null> => ipcRenderer.invoke('dialog:chooseExportPath', suggestedName),
  pathForFile: (file: File) => webUtils.getPathForFile(file),

  analyze: (filePath: string): Promise<MediaAnalysis> => ipcRenderer.invoke('media:analyze', filePath),
  onAnalyzeProgress: (listener: (filePath: string, fraction: number) => void) => subscribe('media:analyze-progress', listener),
  encoders: (): Promise<string[]> => ipcRenderer.invoke('media:encoders'),

  openProject: (): Promise<{ path: string; project: Project } | null> => ipcRenderer.invoke('project:open'),
  saveProject: (project: Project, filePath: string | null): Promise<string | null> => ipcRenderer.invoke('project:save', project, filePath),
  autosave: (project: Project, projectPath: string | null): Promise<void> => ipcRenderer.invoke('project:autosave', project, projectPath),
  restore: (): Promise<{ project: Project; projectPath: string | null } | null> => ipcRenderer.invoke('project:restore'),

  startExport: (request: ExportRequest): Promise<string> => ipcRenderer.invoke('export:start', request),
  cancelExport: (): Promise<void> => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (listener: (progress: ExportProgress) => void) => subscribe('export:progress', listener),

  showItemInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:showItem', filePath)
};

export type DesktopApi = typeof desktopApi;

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
