// Types shared by the Electron main process and the renderer.

/** Analysis envelopes are RMS values sampled at this rate (frames per second). */
export const ENVELOPE_RATE = 100;

export type MediaInfo = {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
};

export type MediaAnalysis = MediaInfo & {
  /** Linear RMS (0..1) of the file's first audio stream, ENVELOPE_RATE values per second. */
  envelope: Float32Array;
};

/** A file placed on the shared timeline. `offsetSec` is where the file's own 0s lands on the timeline. */
export type Track = {
  id: string;
  path: string;
  offsetSec: number;
  info?: MediaInfo;
  /** Set by auto-sync; below ~1.5 the match is doubtful and worth checking by ear. */
  syncConfidence?: number;
};

export type CameraRole = 'speaker' | 'wide';

export type Camera = Track & {
  name: string;
  role: CameraRole;
  color: string;
};

export type Mic = Track & {
  name: string;
  /** Camera to show while this mic is talking. null = no close-up (falls back to wide / current shot). */
  cameraId: string | null;
  volumeDb: number;
  muted: boolean;
};

export type Override = {
  id: string;
  /** Camera id to force, in timeline seconds. */
  cameraId: string;
  startSec: number;
  endSec: number;
};

export type CutSettings = {
  /** 0..1, higher picks up quieter speech. */
  sensitivity: number;
  /** Shortest shot allowed before switching again (seconds). */
  minShotSec: number;
  /** Two mics within this many dB of each other count as crosstalk. */
  crosstalkDb: number;
  /** Cut to the wide shot when several people talk at once. */
  wideOnCrosstalk: boolean;
  /** Cut to the wide shot after this much silence (0 = never). */
  wideAfterSilenceSec: number;
  /** Break up a single close-up longer than this with a wide cutaway (0 = never). */
  maxCloseupSec: number;
  wideCutawaySec: number;
};

export type OutputSettings = {
  width: number;
  height: number;
  fps: number;
  /** x264 CRF, lower = better. */
  quality: number;
  encoder: 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf';
  normalizeLoudness: boolean;
};

export type Project = {
  version: 2;
  cameras: Camera[];
  mics: Mic[];
  overrides: Override[];
  /** Export range in timeline seconds; null = from the start / to the end. */
  inSec: number | null;
  outSec: number | null;
  cut: CutSettings;
  output: OutputSettings;
};

export type Shot = {
  startSec: number;
  endSec: number;
  /** null = no camera covers this time; exported as black. */
  cameraId: string | null;
  reason: 'speaker' | 'crosstalk' | 'silence' | 'cutaway' | 'override' | 'fallback';
};

export type ExportRequest = {
  project: Project;
  shots: Shot[];
  startSec: number;
  endSec: number;
  outputPath: string;
};

export type ExportProgress = {
  stage: 'video' | 'audio' | 'mux' | 'done';
  /** 0..1 overall. */
  progress: number;
  message: string;
};

export const DEFAULT_CUT: CutSettings = {
  sensitivity: 0.5,
  minShotSec: 2.5,
  crosstalkDb: 6,
  wideOnCrosstalk: true,
  wideAfterSilenceSec: 4,
  maxCloseupSec: 30,
  wideCutawaySec: 4
};

export const DEFAULT_OUTPUT: OutputSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  quality: 20,
  encoder: 'libx264',
  normalizeLoudness: true
};

export const emptyProject = (): Project => ({
  version: 2,
  cameras: [],
  mics: [],
  overrides: [],
  inSec: null,
  outSec: null,
  cut: { ...DEFAULT_CUT },
  output: { ...DEFAULT_OUTPUT }
});

export const trackEnd = (track: Track) => track.offsetSec + (track.info?.durationSec ?? 0);

/**
 * The tracks that provide sound and drive the cuts. Normally the mics; with no mic files, each camera's own
 * audio stands in, so a camera-only project still has sound and still cuts. Only one camera is heard (the wide
 * shot if there is one), because mixing several cameras filming the same room sounds echoey.
 */
export function soundSources(project: Project): Mic[] {
  if (project.mics.length) {
    return project.mics;
  }
  const cameras = project.cameras.filter((camera) => camera.info?.hasAudio);
  const heard = cameras.find((camera) => camera.role === 'wide') ?? cameras[0];
  return cameras.map((camera) => ({
    id: `camera-audio:${camera.id}`,
    path: camera.path,
    name: `${camera.name} sound`,
    offsetSec: camera.offsetSec,
    info: camera.info,
    cameraId: camera.role === 'speaker' ? camera.id : null,
    volumeDb: 0,
    muted: camera !== heard
  }));
}

/** Full timeline span covered by any track. */
export function timelineDuration(project: Project) {
  const tracks: Track[] = [...project.cameras, ...project.mics];
  return tracks.reduce((max, track) => Math.max(max, trackEnd(track)), 0);
}

export function exportRange(project: Project) {
  const duration = timelineDuration(project);
  const start = Math.max(0, Math.min(project.inSec ?? 0, duration));
  const end = Math.max(start, Math.min(project.outSec ?? duration, duration));
  return { start, end };
}
