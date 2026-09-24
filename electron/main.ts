import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ExportRequest, Project } from '../src/shared/types';
import { CancelledError } from './ffmpeg';
import { ExportJob } from './exporter';
import { analyzeMedia, detectEncoders } from './media';

const MEDIA_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aif', 'aiff'];
const PROJECT_EXTENSION = 'cutcast';

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg'
};

// Lets the renderer stream local media into <video>/<audio> with seeking, in dev and packaged builds alike.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

let mainWindow: BrowserWindow | null = null;
let currentExport: ExportJob | null = null;

const cacheDir = () => path.join(app.getPath('userData'), 'analysis-cache');
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.json');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#15171c',
    title: 'Cutcast',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Serve `media://file/<encoded path>` with HTTP range support so the preview can seek. */
async function handleMediaRequest(request: Request) {
  const url = new URL(request.url);
  const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const extension = path.extname(filePath).toLowerCase();
  if (!MEDIA_EXTENSIONS.includes(extension.slice(1))) {
    return new Response('Not a media file', { status: 403 });
  }

  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream' });
  const range = request.headers.get('Range')?.match(/bytes=(\d*)-(\d*)/);
  if (!range) {
    headers.set('Content-Length', String(size));
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { status: 200, headers });
  }

  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, { status: 206, headers });
}

async function readProject(filePath: string) {
  const project = JSON.parse(await fs.readFile(filePath, 'utf8')) as Project;
  if (project.version !== 2 || !Array.isArray(project.cameras)) {
    throw new Error('This project file was made by an older version and can’t be opened.');
  }
  return project;
}

function registerIpc() {
  ipcMain.handle('dialog:openMedia', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video and audio', extensions: MEDIA_EXTENSIONS }]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:chooseExportPath', async (_event, suggestedName: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: suggestedName,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  ipcMain.handle('media:analyze', (event, filePath: string) =>
    analyzeMedia(filePath, cacheDir(), (fraction) => event.sender.send('media:analyze-progress', filePath, fraction))
  );

  ipcMain.handle('media:encoders', () => detectEncoders());

  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Cutcast project', extensions: [PROJECT_EXTENSION] }]
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const filePath = result.filePaths[0];
    return { path: filePath, project: await readProject(filePath) };
  });

  ipcMain.handle('project:save', async (_event, project: Project, filePath: string | null) => {
    let target = filePath;
    if (!target) {
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: `My podcast.${PROJECT_EXTENSION}`,
        filters: [{ name: 'Cutcast project', extensions: [PROJECT_EXTENSION] }]
      });
      if (result.canceled || !result.filePath) {
        return null;
      }
      target = result.filePath;
    }
    await fs.writeFile(target, JSON.stringify(project, null, 2));
    return target;
  });

  ipcMain.handle('project:autosave', async (_event, project: Project, projectPath: string | null) => {
    await fs.writeFile(autosavePath(), JSON.stringify({ project, projectPath })).catch(() => undefined);
  });

  ipcMain.handle('project:restore', async () => {
    try {
      return JSON.parse(await fs.readFile(autosavePath(), 'utf8')) as { project: Project; projectPath: string | null };
    } catch {
      return null;
    }
  });

  ipcMain.handle('export:start', async (event, request: ExportRequest) => {
    if (currentExport) {
      throw new Error('An export is already running.');
    }
    const job = new ExportJob(request, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('export:progress', progress);
      }
    });
    currentExport = job;
    try {
      return await job.start();
    } catch (error) {
      if (error instanceof CancelledError) {
        await fs.rm(request.outputPath, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      currentExport = null;
    }
  });

  ipcMain.handle('export:cancel', () => currentExport?.cancel());

  ipcMain.handle('shell:showItem', (_event, filePath: string) => shell.showItemInFolder(filePath));
}

app.whenReady().then(() => {
  protocol.handle('media', handleMediaRequest);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => currentExport?.cancel());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
