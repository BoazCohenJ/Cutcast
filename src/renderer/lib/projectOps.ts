import { findOffset } from '../../shared/sync';
import type { Camera, MediaAnalysis, MediaInfo, Mic, OutputSettings, Project, Track } from '../../shared/types';
import { CAMERA_COLORS, createId, fileName, stripExtension } from './util';

export type Analyses = ReadonlyMap<string, MediaAnalysis>;

const infoOf = ({ envelope: _envelope, ...info }: MediaAnalysis): MediaInfo => info;

/** Sort new files into cameras and mics, and wire each mic to a close-up camera. */
export function addFiles(project: Project, files: Array<{ path: string; analysis: MediaAnalysis }>): Project {
  const cameras = [...project.cameras];
  const mics = [...project.mics];

  for (const { path, analysis } of files) {
    const name = stripExtension(fileName(path));
    if (analysis.hasVideo) {
      const speakerCount = cameras.filter((camera) => camera.role === 'speaker').length;
      const looksWide = /wide|master|group|all/i.test(name);
      const hasWide = cameras.some((camera) => camera.role === 'wide');
      cameras.push({
        id: createId(),
        path,
        name,
        offsetSec: 0,
        info: infoOf(analysis),
        // Typical setup: two close-ups first, then a wide.
        role: looksWide || (speakerCount >= 2 && !hasWide) ? 'wide' : 'speaker',
        color: CAMERA_COLORS[cameras.length % CAMERA_COLORS.length]
      });
    } else if (analysis.hasAudio) {
      mics.push({ id: createId(), path, name, offsetSec: 0, info: infoOf(analysis), cameraId: null, volumeDb: 0, muted: false });
    }
  }

  // Give each unassigned mic the next close-up camera that doesn't have a mic yet.
  for (const mic of mics) {
    if (mic.cameraId && cameras.some((camera) => camera.id === mic.cameraId)) {
      continue;
    }
    const free = cameras.find((camera) => camera.role === 'speaker' && !mics.some((other) => other.cameraId === camera.id));
    mic.cameraId = free?.id ?? null;
  }

  return { ...project, cameras, mics, output: matchOutputToCameras(project.output, project.cameras.length ? [] : cameras) };
}

/** On the first import, default the export size to the main camera's format. */
function matchOutputToCameras(output: OutputSettings, cameras: Camera[]): OutputSettings {
  const main = cameras.find((camera) => camera.info?.width && camera.info.height);
  if (!main?.info?.width || !main.info.height) {
    return output;
  }
  const fps = main.info.fps ? [24, 25, 30, 50, 60].reduce((best, value) => (Math.abs(value - main.info!.fps!) < Math.abs(best - main.info!.fps!) ? value : best)) : output.fps;
  return { ...output, width: main.info.width - (main.info.width % 2), height: main.info.height - (main.info.height % 2), fps };
}

/** Shift everything so the earliest file starts at 0. */
export function normalizeOffsets(project: Project): Project {
  const tracks: Track[] = [...project.cameras, ...project.mics];
  if (!tracks.length) {
    return project;
  }
  const shift = Math.min(...tracks.map((track) => track.offsetSec));
  if (Math.abs(shift) < 1e-9) {
    return project;
  }
  return {
    ...project,
    cameras: project.cameras.map((camera) => ({ ...camera, offsetSec: camera.offsetSec - shift })),
    mics: project.mics.map((mic) => ({ ...mic, offsetSec: mic.offsetSec - shift })),
    overrides: project.overrides.map((item) => ({ ...item, startSec: item.startSec - shift, endSec: item.endSec - shift })),
    inSec: project.inSec === null ? null : project.inSec - shift,
    outSec: project.outSec === null ? null : project.outSec - shift
  };
}

/**
 * Line every file up against a reference by matching their audio.
 * Mics make the best reference: they're cleaner than camera scratch audio.
 */
export function autoSync(project: Project, analyses: Analyses, onlyIds?: ReadonlySet<string>): Project {
  const envelope = (track: Track) => analyses.get(track.path)?.envelope;
  const tracks: Track[] = [...project.mics, ...project.cameras];
  // When syncing just-added files, anchor on something already placed so earlier nudges survive.
  const ordered = onlyIds ? [...tracks.filter((track) => !onlyIds.has(track.id)), ...tracks.filter((track) => onlyIds.has(track.id))] : tracks;
  const reference = ordered.find((track) => (envelope(track)?.length ?? 0) > 0);
  if (!reference) {
    return project;
  }
  const referenceEnvelope = envelope(reference)!;

  const sync = <T extends Track>(track: T): T => {
    if (onlyIds && !onlyIds.has(track.id)) {
      return track;
    }
    if (track.id === reference.id) {
      return { ...track, syncConfidence: undefined };
    }
    const own = envelope(track);
    if (!own?.length) {
      return track;
    }
    if (track.path === reference.path) {
      return { ...track, offsetSec: reference.offsetSec, syncConfidence: undefined };
    }
    const result = findOffset(referenceEnvelope, own);
    return { ...track, offsetSec: reference.offsetSec + result.offsetSec, syncConfidence: result.confidence };
  };

  return normalizeOffsets({ ...project, cameras: project.cameras.map(sync), mics: project.mics.map(sync) });
}

export const allTracks = (project: Project): Array<Camera | Mic> => [...project.cameras, ...project.mics];

export function updateTrack(project: Project, id: string, patch: Partial<Camera> & Partial<Mic>): Project {
  return {
    ...project,
    cameras: project.cameras.map((camera) => (camera.id === id ? { ...camera, ...patch } : camera)),
    mics: project.mics.map((mic) => (mic.id === id ? { ...mic, ...patch } : mic))
  };
}

export function removeTrack(project: Project, id: string): Project {
  return {
    ...project,
    cameras: project.cameras.filter((camera) => camera.id !== id),
    mics: project.mics.map((mic) => (mic.cameraId === id ? { ...mic, cameraId: null } : mic)).filter((mic) => mic.id !== id),
    overrides: project.overrides.filter((item) => item.cameraId !== id)
  };
}

/** Force a camera over a time range, replacing any overrides it overlaps. */
export function setOverride(project: Project, startSec: number, endSec: number, cameraId: string | null): Project {
  const kept = project.overrides.flatMap((item) => {
    if (item.endSec <= startSec || item.startSec >= endSec) {
      return [item];
    }
    const pieces = [];
    if (item.startSec < startSec) {
      pieces.push({ ...item, id: createId(), endSec: startSec });
    }
    if (item.endSec > endSec) {
      pieces.push({ ...item, id: createId(), startSec: endSec });
    }
    return pieces;
  });
  const overrides = cameraId ? [...kept, { id: createId(), cameraId, startSec, endSec }] : kept;
  return { ...project, overrides: overrides.sort((a, b) => a.startSec - b.startSec) };
}
