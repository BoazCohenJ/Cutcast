import { describe, expect, it } from 'vitest';
import { emptyProject, ENVELOPE_RATE, type MediaAnalysis } from '../../shared/types';
import { addFiles, autoSync } from './projectOps';

/** Bursts of loudness at pseudo-random times, so two copies can only line up one way. */
function speech(seconds: number, seed: number) {
  const out = new Float32Array(seconds * ENVELOPE_RATE);
  let level = 0;
  for (let index = 0; index < out.length; index += 1) {
    if (index % 20 === 0) {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      level = seed / 4294967296 > 0.5 ? 0.1 : 0.001;
    }
    out[index] = level;
  }
  return out;
}

const analysis = (hasVideo: boolean, envelopes: Float32Array[], titles: string[] = []): MediaAnalysis => ({
  durationSec: envelopes[0].length / ENVELOPE_RATE,
  hasVideo,
  hasAudio: envelopes.length > 0,
  audioTracks: envelopes.map((_, index) => ({ title: titles[index], layout: 'mono' })),
  envelopes
});

describe('files with several audio tracks', () => {
  it('turns each picked track into its own mic', () => {
    const file = { path: 'show.mp4', analysis: analysis(true, [speech(60, 1), speech(60, 2)], ['Host']) };
    const project = addFiles(emptyProject(), [file], new Map([['show.mp4', [0, 1]]]));

    expect(project.cameras.map((camera) => camera.path)).toEqual(['show.mp4']);
    expect(project.mics.map(({ path, name, audioTrack }) => ({ path, name, audioTrack }))).toEqual([
      { path: 'show.mp4', name: 'show Track 1 (Host)', audioTrack: 0 },
      { path: 'show.mp4', name: 'show Track 2', audioTrack: 1 }
    ]);
    expect(project.mics[0].cameraId).toBe(project.cameras[0].id);
  });

  it('adds no mic from a video unless tracks were picked, and the first track of an audio file', () => {
    const video = { path: 'cam.mp4', analysis: analysis(true, [speech(60, 1)]) };
    const audio = { path: 'mic.wav', analysis: analysis(false, [speech(60, 2)]) };
    const project = addFiles(emptyProject(), [video, audio]);
    expect(project.mics.map(({ path, name, audioTrack }) => ({ path, name, audioTrack }))).toEqual([{ path: 'mic.wav', name: 'mic', audioTrack: 0 }]);
  });

  it('syncs against the picked track, not the first one', () => {
    const guest = speech(120, 7);
    // The camera started 3 s after the recorder, and its scratch audio hears the guest.
    const camera = guest.slice(3 * ENVELOPE_RATE);
    const recorder = { path: 'recorder.wav', analysis: analysis(false, [speech(120, 9), guest]) };
    const cam = { path: 'cam.mp4', analysis: analysis(true, [camera]) };
    const added = addFiles(emptyProject(), [recorder, cam], new Map([['recorder.wav', [1]]]));
    const synced = autoSync(added, new Map([[recorder.path, recorder.analysis], [cam.path, cam.analysis]]));

    expect(synced.mics[0].offsetSec).toBe(0);
    expect(synced.cameras[0].offsetSec).toBeCloseTo(3, 1);
  });
});
