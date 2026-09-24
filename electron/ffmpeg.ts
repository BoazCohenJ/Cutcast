import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

/** ffmpeg-static points inside app.asar once packaged; the binary itself lives in app.asar.unpacked. */
export function ffmpegPath() {
  if (!ffmpegStatic) {
    throw new Error('The bundled ffmpeg could not be found.');
  }
  return ffmpegStatic.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export class CancelledError extends Error {
  constructor() {
    super('Export cancelled.');
  }
}

export type RunOptions = {
  /** Called with each `key=value` line from `-progress pipe:1`. */
  onProgress?: (values: Record<string, string>) => void;
  onSpawn?: (child: ChildProcess) => void;
};

/** Run ffmpeg, keeping the tail of stderr so failures come back with a readable reason. */
export function runFfmpeg(args: string[], options: RunOptions = {}) {
  return new Promise<void>((resolve, reject) => {
    const withProgress = options.onProgress ? ['-progress', 'pipe:1', '-nostats'] : [];
    const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...withProgress, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    options.onSpawn?.(child);

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    let pending = '';
    let block: Record<string, string> = {};
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const split = line.indexOf('=');
        if (split < 0) {
          continue;
        }
        const key = line.slice(0, split).trim();
        block[key] = line.slice(split + 1).trim();
        if (key === 'progress') {
          options.onProgress?.(block);
          block = {};
        }
      }
    });

    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal || child.killed) {
        reject(new CancelledError());
      } else {
        const reason = stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `exit code ${code}`;
        reject(new Error(`ffmpeg failed: ${reason}`));
      }
    });
  });
}
