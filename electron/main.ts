import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

type MediaSource = {
  id: string;
  kind: 'audio' | 'video';
  path: string;
  label: string;
  offsetSec: number;
};

type CameraFeed = {
  id: string;
  name: string;
  videoPath: string;
  videoOffsetSec: number;
  sources: MediaSource[];
};

type OverrideBlock = {
  id: string;
  cameraId: string;
  startSec: number;
  endSec: number;
};

type ExportProject = {
  cameras: CameraFeed[];
  overrides: OverrideBlock[];
  totalDurationSec: number;
  outputPath: string;
};

type AudioEnvelope = number[];

type SegmentPlan = {
  startSec: number;
  endSec: number;
  camera: CameraFeed;
  source: MediaSource;
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 980,
    backgroundColor: '#f6f1e8',
    title: 'Podcast Autocut',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(app.getAppPath(), 'dist-renderer', 'index.html'));
  }
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
  });
}

async function ensureFileExists(filePath: string) {
  await fs.access(filePath);
}

async function probeDuration(inputPath: string) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary could not be found.');
  }

  const probe = spawn(ffmpegPath, ['-i', inputPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  probe.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  await new Promise<void>((resolve) => {
    probe.once('close', () => resolve());
  });

  const match = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!match) {
    return 0;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

async function exportProject(project: ExportProject) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary could not be found.');
  }

  if (!project.cameras.length) {
    throw new Error('Add at least one camera feed before exporting.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast-autocut-'));
  const segmentList: string[] = [];
  const measuredDurations = await Promise.all([
    ...project.cameras.map(async (camera) => ({ duration: await probeDuration(camera.videoPath), offset: camera.videoOffsetSec })),
    ...project.cameras.flatMap((camera) => camera.sources.map(async (source) => ({ duration: await probeDuration(source.path), offset: source.offsetSec })))
  ]);
  const duration = Math.max(1, ...measuredDurations.map((item) => item.duration + item.offset));
  const envelopes = await buildAudioEnvelopes(project.cameras);
  const segmentPlan = buildSegmentPlan(project.cameras, project.overrides, envelopes, duration, 5);

  for (let index = 0; index < segmentPlan.length; index += 1) {
    const segment = segmentPlan[index];
    const segmentPath = path.join(tempRoot, `segment-${String(index).padStart(3, '0')}.mp4`);
    const segmentDuration = Math.max(0.1, segment.endSec - segment.startSec);

    await runCommand(ffmpegPath, [
      '-y',
      '-ss', String(Math.max(0, segment.startSec - segment.camera.videoOffsetSec)),
      '-i', segment.camera.videoPath,
      '-ss', String(Math.max(0, segment.startSec - segment.source.offsetSec)),
      '-i', segment.source.path,
      '-t', String(segmentDuration),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      segmentPath
    ]);

    segmentList.push(segmentPath);
  }

  const concatFile = path.join(tempRoot, 'concat.txt');
  await fs.writeFile(concatFile, segmentList.map((segment) => `file '${segment.replace(/'/g, "'\\''")}'`).join('\n'));
  await runCommand(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', project.outputPath]);
  return project.outputPath;
}

async function buildAudioEnvelopes(cameras: CameraFeed[]) {
  const entries: Array<[string, AudioEnvelope]> = [];

  for (const camera of cameras) {
    for (const source of camera.sources) {
      entries.push([source.id, await analyzeAudioEnvelope(source.path)]);
    }
  }

  return new Map(entries);
}

async function analyzeAudioEnvelope(inputPath: string) {
  if (!ffmpegPath) {
    return [];
  }

  const probe = spawn(ffmpegPath, [
    '-v',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '8000',
    '-f',
    's16le',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  const chunks: Buffer[] = [];
  probe.stdout.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk));
  });

  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Audio analysis failed for ${inputPath}`));
      }
    });
  });

  const buffer = Buffer.concat(chunks);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  const samplesPerSlice = 8000;
  const envelope: number[] = [];

  for (let start = 0; start < samples.length; start += samplesPerSlice) {
    const end = Math.min(samples.length, start + samplesPerSlice);
    let total = 0;

    for (let index = start; index < end; index += 1) {
      const value = samples[index] / 32768;
      total += value * value;
    }

    envelope.push(end > start ? Math.sqrt(total / (end - start)) : 0);
  }

  return envelope;
}

function buildSegmentPlan(
  cameras: CameraFeed[],
  overrides: OverrideBlock[],
  envelopes: Map<string, AudioEnvelope>,
  totalDurationSec: number,
  segmentLengthSec: number
) {
  const segments: SegmentPlan[] = [];
  const segmentCount = Math.max(1, Math.ceil(totalDurationSec / segmentLengthSec));

  for (let index = 0; index < segmentCount; index += 1) {
    const startSec = index * segmentLengthSec;
    const endSec = Math.min(totalDurationSec, startSec + segmentLengthSec);
    const override = overrides.find((item) => startSec < item.endSec && endSec > item.startSec);
    const forcedCamera = override ? cameras.find((camera) => camera.id === override.cameraId) : undefined;

    if (forcedCamera && forcedCamera.sources[0]) {
      segments.push({ startSec, endSec, camera: forcedCamera, source: forcedCamera.sources[0] });
      continue;
    }

    let winningCamera = cameras[0];
    let winningSource = cameras[0]?.sources[0];
    let winningScore = -1;

    for (const camera of cameras) {
      for (const source of camera.sources) {
        const envelope = envelopes.get(source.id);
        const sampleIndex = Math.floor(startSec);
        const score = envelope?.[sampleIndex] ?? 0;

        if (score > winningScore) {
          winningScore = score;
          winningCamera = camera;
          winningSource = source;
        }
      }
    }

    if (winningCamera && winningSource) {
      segments.push({ startSec, endSec, camera: winningCamera, source: winningSource });
    }
  }

  return mergeAdjacentSegments(segments);
}

function mergeAdjacentSegments(segments: SegmentPlan[]) {
  if (segments.length <= 1) {
    return segments;
  }

  const merged: SegmentPlan[] = [segments[0]];

  for (let index = 1; index < segments.length; index += 1) {
    const current = segments[index];
    const previous = merged[merged.length - 1];

    if (previous.camera.id === current.camera.id && previous.source.id === current.source.id) {
      previous.endSec = current.endSec;
    } else {
      merged.push(current);
    }
  }

  return merged;
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('dialog:openMediaFiles', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media files', extensions: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }
      ]
    });

    if (result.canceled) {
      return [];
    }

    return result.filePaths;
  });

  ipcMain.handle('dialog:chooseSaveFile', async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: 'podcast-autocut-export.mp4',
      filters: [{ name: 'MPEG-4 Video', extensions: ['mp4'] }]
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return result.filePath;
  });

  ipcMain.handle('dialog:help', async () => {
    await dialog.showMessageBox({
      type: 'info',
      title: 'How to use Podcast Autocut',
      message: '1. Add each camera feed. 2. Attach one or more mic files to that camera. 3. Drag the clip bars until they line up. 4. Use the override rows if you want a manual cut. 5. Export to make one final MP4.'
    });
  });

  ipcMain.handle('project:export', async (_event, payload: ExportProject) => {
    for (const camera of payload.cameras) {
      await ensureFileExists(camera.videoPath);
      for (const source of camera.sources) {
        await ensureFileExists(source.path);
      }
    }

    const exportedPath = await exportProject(payload);
    await shell.showItemInFolder(exportedPath);
    return exportedPath;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
