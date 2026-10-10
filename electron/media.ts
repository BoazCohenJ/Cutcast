import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ENVELOPE_RATE, type MediaAnalysis, type MediaInfo } from '../src/shared/types';
import { ffmpegPath, runFfmpeg } from './ffmpeg';

const ANALYSIS_SAMPLE_RATE = 8000;
const CACHE_VERSION = 4;

/** Read duration and stream details from ffmpeg's banner (ffmpeg-static ships without ffprobe). */
export async function probeMedia(inputPath: string): Promise<MediaInfo> {
  const child = spawn(ffmpegPath(), ['-hide_banner', '-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let output = '';
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });

  if (/No such file or directory|Invalid data found/i.test(output)) {
    throw new Error(`Can't read ${path.basename(inputPath)}. Is it a video or audio file?`);
  }

  const duration = output.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const videoLine = output
    .split(/\r?\n/)
    .find((line) => /Stream #.*Video:/.test(line) && !/attached pic/.test(line));
  const audioTracks = audioTracksOf(output);
  const size = videoLine?.match(/, (\d{2,5})x(\d{2,5})/);
  const fps = videoLine?.match(/([\d.]+) fps/) ?? videoLine?.match(/([\d.]+) tbr/);
  const rotation = output.match(/rotation of (-?[\d.]+) degrees/);
  const rotated = rotation ? Math.abs(Number(rotation[1])) % 180 === 90 : false;

  const info: MediaInfo = {
    durationSec: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    hasVideo: Boolean(videoLine),
    hasAudio: audioTracks.length > 0,
    audioTracks
  };
  if (size) {
    info.width = Number(rotated ? size[2] : size[1]);
    info.height = Number(rotated ? size[1] : size[2]);
  }
  if (fps) {
    info.fps = Number(fps[1]);
  }
  return info;
}

/** Each audio stream's title (when the recorder set one) and channel layout. */
function audioTracksOf(output: string) {
  const tracks: NonNullable<MediaInfo['audioTracks']> = [];
  let current: (typeof tracks)[number] | null = null;
  const flush = () => {
    if (current) {
      tracks.push(current);
    }
  };
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Stream #/.test(line)) {
      flush();
      current = /Audio:/.test(line) ? { layout: line.match(/ Hz, ([^,]+)/)?.[1] } : null;
    } else if (current) {
      const title = line.match(/^\s+title\s*: (.+)$/);
      if (title) {
        current.title = title[1].trim();
      }
    }
  }
  flush();
  return tracks;
}

/** True when the picture is flat black at a few sampled points, rather than a real camera. */
async function hasBlackPicture(inputPath: string, durationSec: number) {
  for (const fraction of [0.1, 0.5, 0.9]) {
    const child = spawn(
      ffmpegPath(),
      ['-hide_banner', '-ss', (durationSec * fraction).toFixed(2), '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-vf', 'signalstats,metadata=print', '-an', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await new Promise<void>((resolve) => {
      child.once('error', () => resolve());
      child.once('close', () => resolve());
    });
    const brightest = output.match(/lavfi\.signalstats\.YMAX=(\d+)/);
    // Limited-range black is 16; leave a little room for encoder noise.
    if (!brightest || Number(brightest[1]) > 24) {
      return false;
    }
  }
  return true;
}

async function cacheFile(cacheDir: string, inputPath: string) {
  const stat = await fs.stat(inputPath);
  const key = createHash('sha1').update(`${CACHE_VERSION}|${path.resolve(inputPath)}|${stat.size}|${stat.mtimeMs}`).digest('hex');
  return path.join(cacheDir, `${key}.json`);
}

/**
 * Decode one audio stream to 8 kHz mono and reduce it to an RMS envelope, streaming. The envelope starts at the file's
 * time 0, like the preview and export do: a track whose sound starts late (common in camera and recorder files) gets
 * leading silence instead of being shifted earlier, which would put it out of sync with the picture.
 */
async function computeEnvelope(inputPath: string, audioTrack: number, durationSec: number, onProgress: (fraction: number) => void) {
  const child = spawn(
    ffmpegPath(),
    ['-v', 'error', '-i', inputPath, '-map', `0:a:${audioTrack}`, '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(ANALYSIS_SAMPLE_RATE), '-f', 's16le', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  const samplesPerFrame = ANALYSIS_SAMPLE_RATE / ENVELOPE_RATE;
  const values: number[] = [];
  let energy = 0;
  let count = 0;
  let leftover: Buffer | null = null;
  let lastReport = 0;

  child.stdout.on('data', (chunk: Buffer) => {
    const data: Buffer = leftover ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = data.length - (data.length % 2);
    leftover = usable < data.length ? data.subarray(usable) : null;
    for (let offset = 0; offset < usable; offset += 2) {
      const sample = data.readInt16LE(offset) / 32768;
      energy += sample * sample;
      count += 1;
      if (count === samplesPerFrame) {
        values.push(Math.sqrt(energy / count));
        energy = 0;
        count = 0;
      }
    }
    const fraction = durationSec > 0 ? values.length / ENVELOPE_RATE / durationSec : 0;
    if (fraction - lastReport > 0.02) {
      lastReport = fraction;
      onProgress(Math.min(1, fraction));
    }
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`Couldn't read the audio: ${stderr.trim().split(/\r?\n/).pop()}`))));
  });

  if (count > 0) {
    values.push(Math.sqrt(energy / count));
  }
  return Float32Array.from(values);
}

export async function analyzeMedia(inputPath: string, cacheDir: string, onProgress: (fraction: number) => void): Promise<MediaAnalysis> {
  await fs.access(inputPath).catch(() => {
    throw new Error(`File not found: ${inputPath}`);
  });

  const cachePath = await cacheFile(cacheDir, inputPath);
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as MediaInfo & { envelopes: string[] };
    const envelopes = cached.envelopes.map((encoded) => {
      const bytes = Buffer.from(encoded, 'base64');
      return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
    onProgress(1);
    return { ...cached, envelopes };
  } catch {
    // Not cached yet.
  }

  const info = await probeMedia(inputPath);
  if (info.hasVideo && info.hasAudio && (await hasBlackPicture(inputPath, info.durationSec))) {
    info.blankPicture = true;
  }
  const trackCount = info.audioTracks?.length ?? 0;
  const envelopes: Float32Array[] = [];
  for (let track = 0; track < trackCount; track += 1) {
    envelopes.push(await computeEnvelope(inputPath, track, info.durationSec, (fraction) => onProgress((track + fraction) / trackCount)));
  }
  onProgress(1);

  await fs.mkdir(cacheDir, { recursive: true });
  const encoded = envelopes.map((envelope) => Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength).toString('base64'));
  await fs.writeFile(cachePath, JSON.stringify({ ...info, envelopes: encoded })).catch(() => undefined);
  return { ...info, envelopes };
}

/** Which H.264 encoders actually work on this machine (hardware encoders depend on the GPU and driver). */
export async function detectEncoders() {
  const candidates = ['h264_nvenc', 'h264_qsv', 'h264_amf'] as const;
  const results = await Promise.all(
    candidates.map(async (encoder) => {
      try {
        await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=30', '-frames:v', '5', '-c:v', encoder, '-f', 'null', '-']);
        return encoder;
      } catch {
        return null;
      }
    })
  );
  return ['libx264', ...results.filter((encoder) => encoder !== null)];
}
