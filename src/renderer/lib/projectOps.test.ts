import { describe, expect, it } from 'vitest';
import { emptyProject, ENVELOPE_RATE, isSilentEnvelope, type MediaAnalysis } from '../../shared/types';
import { addFiles, autoSync, importedPaths } from './projectOps';

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

describe('adding video and audio separately', () => {
  // Two cameras with their own built-in mics, and one blank-picture MP4 carrying a clean mic per person.
  const camA = { path: 'camA.mp4', analysis: analysis(true, [speech(60, 1)]) };
  const camB = { path: 'camB.mp4', analysis: analysis(true, [speech(60, 2)]) };
  const recorder = { path: 'mics.mp4', analysis: analysis(true, [speech(60, 3), speech(60, 4)], ['Host']) };

  it('takes only the picture as video and only the picked tracks as audio', () => {
    const withVideo = addFiles(emptyProject(), [camA, camB], 'video');
    const project = addFiles(withVideo, [recorder], 'audio', new Map([['mics.mp4', [0, 1]]]));

    expect(project.cameras.map((camera) => camera.path)).toEqual(['camA.mp4', 'camB.mp4']);
    expect(project.mics.map(({ path, name, audioTrack }) => ({ path, name, audioTrack }))).toEqual([
      { path: 'mics.mp4', name: 'mics Track 1 (Host)', audioTrack: 0 },
      { path: 'mics.mp4', name: 'mics Track 2', audioTrack: 1 }
    ]);
    // Each mic shows its own camera.
    expect(project.mics.map((mic) => mic.cameraId)).toEqual(project.cameras.map((camera) => camera.id));
  });

  it('links mics to cameras whichever is added first', () => {
    const withAudio = addFiles(emptyProject(), [recorder], 'audio', new Map([['mics.mp4', [0, 1]]]));
    expect(withAudio.cameras).toEqual([]);
    const project = addFiles(withAudio, [camA, camB], 'video');
    expect(project.mics.map((mic) => mic.cameraId)).toEqual(project.cameras.map((camera) => camera.id));
  });

  it('lets one file be both a camera and a mic, but not the same one twice', () => {
    const project = addFiles(emptyProject(), [camA], 'video');
    expect(importedPaths(project, 'video').has('camA.mp4')).toBe(true);
    expect(importedPaths(project, 'audio').has('camA.mp4')).toBe(false);
    const both = addFiles(project, [camA], 'audio');
    expect(both.mics.map(({ path, audioTrack }) => ({ path, audioTrack }))).toEqual([{ path: 'camA.mp4', audioTrack: 0 }]);
    expect(both.cameras).toHaveLength(1);
  });

  it('sorts dropped files: video files become cameras, audio files mics', () => {
    const wav = { path: 'mic.wav', analysis: analysis(false, [speech(60, 5)]) };
    const project = addFiles(emptyProject(), [camA, wav]);
    expect(project.cameras.map((camera) => camera.path)).toEqual(['camA.mp4']);
    expect(project.mics.map(({ path, name, audioTrack }) => ({ path, name, audioTrack }))).toEqual([{ path: 'mic.wav', name: 'mic', audioTrack: 0 }]);
  });

  it('syncs against the picked track, not the first one', () => {
    const guest = speech(120, 7);
    // The camera started 3 s after the recorder, and its scratch audio hears the guest.
    const camera = guest.slice(3 * ENVELOPE_RATE);
    const recorder = { path: 'recorder.wav', analysis: analysis(false, [speech(120, 9), guest]) };
    const cam = { path: 'cam.mp4', analysis: analysis(true, [camera]) };
    const added = addFiles(emptyProject(), [recorder, cam], 'auto', new Map([['recorder.wav', [1]]]));
    const synced = autoSync(added, new Map([[recorder.path, recorder.analysis], [cam.path, cam.analysis]]));

    expect(synced.mics[0].offsetSec).toBe(0);
    expect(synced.cameras[0].offsetSec).toBeCloseTo(3, 1);
  });
});

describe('recorder files with a black placeholder picture', () => {
  const recorder = { path: 'mics.mp4', analysis: { ...analysis(true, [speech(60, 3), speech(60, 4)]), blankPicture: true } };

  it('is taken as audio, not as a black camera, when dropped in', () => {
    const project = addFiles(emptyProject(), [recorder], 'auto', new Map([['mics.mp4', [0, 1]]]));
    expect(project.cameras).toEqual([]);
    expect(project.mics.map((mic) => mic.audioTrack)).toEqual([0, 1]);
  });

  it('never adds its black picture as a camera', () => {
    expect(addFiles(emptyProject(), [recorder], 'video').cameras).toEqual([]);
  });

  it('tells silent tracks from tracks with sound', () => {
    expect(isSilentEnvelope(new Float32Array(1000))).toBe(true);
    expect(isSilentEnvelope(speech(10, 1))).toBe(false);
    expect(isSilentEnvelope(undefined)).toBe(true);
  });
});
