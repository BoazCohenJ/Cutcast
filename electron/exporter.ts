import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Camera, ExportProgress, ExportRequest, OutputSettings } from '../src/shared/types';
import { CancelledError, runFfmpeg } from './ffmpeg';

type Segment = {
  camera: Camera | null;
  /** Timeline second the segment starts at. */
  timelineStart: number;
  frames: number;
};

// Share of the progress bar each stage gets.
const VIDEO_WEIGHT = 0.8;
const AUDIO_WEIGHT = 0.17;

function encoderArgs(output: OutputSettings) {
  const q = String(output.quality);
  switch (output.encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', q, '-b:v', '0'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', q];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', q, '-qp_p', q];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', q, '-profile:v', 'high'];
  }
}

/** Snap every cut to the output frame grid so the video can never drift from the audio. */
function buildSegments(request: ExportRequest): Segment[] {
  const { project, shots, startSec, endSec } = request;
  const fps = project.output.fps;
  const cameras = new Map(project.cameras.map((camera) => [camera.id, camera]));
  const segments: Segment[] = [];

  for (const shot of shots) {
    const from = Math.max(startSec, shot.startSec);
    const to = Math.min(endSec, shot.endSec);
    const firstFrame = Math.round((from - startSec) * fps);
    const lastFrame = Math.round((to - startSec) * fps);
    if (lastFrame <= firstFrame) {
      continue;
    }
    segments.push({
      camera: shot.cameraId ? (cameras.get(shot.cameraId) ?? null) : null,
      timelineStart: startSec + firstFrame / fps,
      frames: lastFrame - firstFrame
    });
  }
  return segments;
}

function segmentArgs(segment: Segment, output: OutputSettings, target: string) {
  const { width, height, fps } = output;
  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
    // If the source runs out a frame early, hold the last frame rather than shortening the segment.
    'tpad=stop=-1:stop_mode=clone',
    'format=yuv420p'
  ].join(',');

  const input = segment.camera
    ? ['-ss', Math.max(0, segment.timelineStart - segment.camera.offsetSec).toFixed(4), '-i', segment.camera.path]
    : ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`];

  return [
    ...input,
    '-map', '0:v:0',
    '-vf', filters,
    '-frames:v', String(segment.frames),
    '-an',
    ...encoderArgs(output),
    '-video_track_timescale', '90000',
    target
  ];
}

function audioArgs(request: ExportRequest, target: string) {
  const { project, startSec, endSec } = request;
  const duration = endSec - startSec;
  const mics = project.mics.filter((mic) => !mic.muted && mic.info?.hasAudio);
  const inputs: string[] = [];
  const chains: string[] = [];

  mics.forEach((mic, index) => {
    const lead = mic.offsetSec - startSec;
    // Seek the input when it started before the export range; delay it when it starts after.
    if (lead < 0) {
      inputs.push('-ss', (-lead).toFixed(4));
    }
    inputs.push('-i', mic.path);
    const delay = lead > 0 ? `,adelay=${Math.round(lead * 1000)}:all=1` : '';
    chains.push(
      `[${index}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${mic.volumeDb}dB${delay}[m${index}]`
    );
  });

  let graph: string;
  if (mics.length) {
    const labels = mics.map((_, index) => `[m${index}]`).join('');
    const master = project.output.normalizeLoudness
      ? 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000'
      : 'alimiter=limit=0.89:level=disabled';
    graph = `${chains.join(';')};${labels}amix=inputs=${mics.length}:duration=longest:normalize=0,apad,atrim=0:${duration.toFixed(4)},${master}[out]`;
  } else {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    graph = `[0:a]atrim=0:${duration.toFixed(4)}[out]`;
  }

  return [...inputs, '-filter_complex', graph, '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', target];
}

export class ExportJob {
  private readonly children = new Set<ChildProcess>();
  private cancelled = false;

  constructor(
    private readonly request: ExportRequest,
    private readonly report: (progress: ExportProgress) => void
  ) {}

  cancel() {
    this.cancelled = true;
    for (const child of this.children) {
      child.kill();
    }
  }

  private run(args: string[], onProgress?: (values: Record<string, string>) => void) {
    if (this.cancelled) {
      return Promise.reject(new CancelledError());
    }
    return runFfmpeg(args, {
      onProgress,
      onSpawn: (child) => {
        this.children.add(child);
        child.once('close', () => this.children.delete(child));
      }
    });
  }

  async start() {
    const { request } = this;
    const segments = buildSegments(request);
    if (!segments.length) {
      throw new Error('Nothing to export. Add a camera and make sure the export range isn’t empty.');
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcast-'));
    try {
      await this.renderVideo(segments, tempDir);

      const audioPath = path.join(tempDir, 'audio.m4a');
      const duration = request.endSec - request.startSec;
      this.report({ stage: 'audio', progress: VIDEO_WEIGHT, message: 'Mixing the microphones' });
      await this.run(audioArgs(request, audioPath), (values) => {
        const done = Number(values.out_time_us ?? 0) / 1e6 / duration;
        this.report({ stage: 'audio', progress: VIDEO_WEIGHT + AUDIO_WEIGHT * Math.min(1, done), message: 'Mixing the microphones' });
      });

      this.report({ stage: 'mux', progress: VIDEO_WEIGHT + AUDIO_WEIGHT, message: 'Putting it all together' });
      const videoPath = path.join(tempDir, 'video.mp4');
      await this.run([
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        '-t', duration.toFixed(4),
        '-movflags', '+faststart',
        request.outputPath
      ]);

      this.report({ stage: 'done', progress: 1, message: 'Done' });
      return request.outputPath;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async renderVideo(segments: Segment[], tempDir: string) {
    const { output } = this.request.project;
    const totalFrames = segments.reduce((sum, segment) => sum + segment.frames, 0);
    const framesDone = new Array<number>(segments.length).fill(0);
    const files = segments.map((_, index) => path.join(tempDir, `seg-${String(index).padStart(5, '0')}.mp4`));

    const update = () => {
      const done = framesDone.reduce((sum, value) => sum + value, 0);
      const completed = framesDone.filter((value, index) => value >= segments[index].frames).length;
      this.report({
        stage: 'video',
        progress: (VIDEO_WEIGHT * done) / totalFrames,
        message: `Rendering shots (${completed} of ${segments.length})`
      });
    };
    update();

    // A couple of encoders in parallel keeps the machine busy through the many short seeks.
    const concurrency = output.encoder === 'libx264' ? Math.max(1, Math.min(3, Math.floor(os.cpus().length / 4))) : 2;
    let next = 0;
    const worker = async () => {
      while (next < segments.length) {
        const index = next;
        next += 1;
        await this.run(segmentArgs(segments[index], output, files[index]), (values) => {
          framesDone[index] = Math.min(segments[index].frames, Number(values.frame ?? 0));
          update();
        });
        framesDone[index] = segments[index].frames;
        update();
      }
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } catch (error) {
      // Stop the other workers before the temp folder is removed underneath them.
      this.cancel();
      throw error;
    }

    const listPath = path.join(tempDir, 'segments.txt');
    await fs.writeFile(listPath, files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    await this.run(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', path.join(tempDir, 'video.mp4')]);
  }
}
