import { describe, expect, it } from 'vitest';
import { planShots, smoothActivity } from './cutEngine';
import { findOffset } from './sync';
import { emptyProject, ENVELOPE_RATE, soundSources, type Camera, type Mic, type Project, type Shot } from './types';

/** Deterministic pseudo-random numbers so tests are stable. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

type Talk = [startSec: number, endSec: number];

/** Syllable-like loudness pattern for one voice (RMS per envelope frame). */
function voice(seconds: number, talk: Talk[], seed: number) {
  const random = rng(seed);
  const out = new Float32Array(seconds * ENVELOPE_RATE);
  let syllable = 0;
  for (let index = 0; index < out.length; index += 1) {
    const time = index / ENVELOPE_RATE;
    if (index % 18 === 0) {
      syllable = random() > 0.25 ? 0.05 + random() * 0.15 : 0.004;
    }
    out[index] = talk.some(([start, end]) => time >= start && time < end) ? syllable : 0;
  }
  return out;
}

/** What one mic hears: its own person, the other person's voice ~16 dB down (bleed), and room noise. */
function envelope(own: Float32Array, other: Float32Array | null, seed: number) {
  const random = rng(seed);
  return own.map((value, index) => value + (other ? other[index] * 0.15 : 0) + 0.001 + random() * 0.001);
}

function setup(talkA: Talk[], talkB: Talk[], seconds: number, withWide = true) {
  const info = { durationSec: seconds, hasVideo: true, hasAudio: true };
  const camera = (id: string, role: Camera['role']): Camera => ({ id, path: `${id}.mp4`, name: id, role, color: '#fff', offsetSec: 0, info });
  const mic = (id: string, cameraId: string): Mic => ({
    id,
    path: `${id}.wav`,
    name: id,
    cameraId,
    offsetSec: 0,
    volumeDb: 0,
    muted: false,
    info: { ...info, hasVideo: false }
  });
  const project: Project = {
    ...emptyProject(),
    cameras: [camera('camA', 'speaker'), camera('camB', 'speaker'), ...(withWide ? [camera('wide', 'wide')] : [])],
    mics: [mic('micA', 'camA'), mic('micB', 'camB')]
  };
  const voiceA = voice(seconds, talkA, 1);
  const voiceB = voice(seconds, talkB, 2);
  const envelopes = new Map([
    ['micA', envelope(voiceA, voiceB, 3)],
    ['micB', envelope(voiceB, voiceA, 4)]
  ]);
  return { project, envelopes };
}

const cameraAt = (shots: Shot[], time: number) => shots.find((shot) => time >= shot.startSec && time < shot.endSec)?.cameraId;

describe('planShots', () => {
  it('follows the person talking and ignores a short interjection', () => {
    const { project, envelopes } = setup([[0, 20]], [[10, 10.5], [20, 40]], 40);
    const shots = planShots(project, envelopes);

    expect(cameraAt(shots, 5)).toBe('camA');
    expect(cameraAt(shots, 10.3)).toBe('camA');
    expect(cameraAt(shots, 15)).toBe('camA');
    expect(cameraAt(shots, 25)).toBe('camB');
    expect(cameraAt(shots, 39)).toBe('camB');
    const switchTime = shots.find((shot) => shot.cameraId === 'camB')!.startSec;
    expect(Math.abs(switchTime - 20)).toBeLessThan(1);
  });

  it('never makes a shot shorter than the minimum', () => {
    const talkA: Talk[] = [];
    const talkB: Talk[] = [];
    // Rapid back-and-forth every 1.2s.
    for (let time = 0; time < 60; time += 2.4) {
      talkA.push([time, time + 1.2]);
      talkB.push([time + 1.2, time + 2.4]);
    }
    const { project, envelopes } = setup(talkA, talkB, 60, false);
    const shots = planShots({ ...project, cut: { ...project.cut, minShotSec: 3 } }, envelopes);
    for (const shot of shots.slice(0, -1)) {
      expect(shot.endSec - shot.startSec).toBeGreaterThanOrEqual(3 - 1e-6);
    }
  });

  it('goes wide for crosstalk and long pauses', () => {
    const { project, envelopes } = setup([[0, 10], [15, 25]], [[15, 25]], 45);
    const shots = planShots({ ...project, cut: { ...project.cut, maxCloseupSec: 0 } }, envelopes);
    expect(cameraAt(shots, 5)).toBe('camA');
    expect(cameraAt(shots, 20)).toBe('wide');
    expect(cameraAt(shots, 40)).toBe('wide');
  });

  it('breaks up a long monologue with a wide cutaway', () => {
    const { project, envelopes } = setup([[0, 90]], [], 90);
    const shots = planShots({ ...project, cut: { ...project.cut, maxCloseupSec: 30, wideAfterSilenceSec: 0 } }, envelopes);
    const cutaways = shots.filter((shot) => shot.reason === 'cutaway');
    expect(cutaways.length).toBeGreaterThanOrEqual(2);
    for (const shot of shots.filter((item) => item.cameraId === 'camA')) {
      expect(shot.endSec - shot.startSec).toBeLessThanOrEqual(45);
    }
  });

  it('applies manual overrides exactly', () => {
    const { project, envelopes } = setup([[0, 30]], [], 30);
    const shots = planShots({ ...project, overrides: [{ id: 'o', cameraId: 'camB', startSec: 10, endSec: 12 }] }, envelopes);
    expect(cameraAt(shots, 9.9)).toBe('camA');
    expect(cameraAt(shots, 11)).toBe('camB');
    expect(cameraAt(shots, 12.1)).toBe('camA');
  });

  it('only uses cameras that have footage at that moment', () => {
    const { project, envelopes } = setup([[0, 40]], [], 40);
    const cameras = project.cameras.map((camera) =>
      camera.id === 'camA' ? { ...camera, offsetSec: 10, info: { ...camera.info!, durationSec: 20 } } : camera
    );
    const shots = planShots({ ...project, cameras }, envelopes);
    expect(cameraAt(shots, 5)).not.toBe('camA');
    expect(cameraAt(shots, 20)).toBe('camA');
    expect(cameraAt(shots, 35)).not.toBe('camA');
    expect(shots[0].startSec).toBe(0);
    expect(shots[shots.length - 1].endSec).toBeCloseTo(40);
  });
});

describe('camera sound when there are no mic files', () => {
  it('plays only the wide camera, but lets every camera drive the cuts', () => {
    const { project } = setup([[0, 10]], [], 10);
    const sources = soundSources({ ...project, mics: [] });
    expect(sources.map((source) => source.path)).toEqual(['camA.mp4', 'camB.mp4', 'wide.mp4']);
    expect(sources.filter((source) => !source.muted).map((source) => source.path)).toEqual(['wide.mp4']);
    expect(sources.find((source) => source.path === 'camA.mp4')?.cameraId).toBe('camA');
    expect(sources.find((source) => source.path === 'wide.mp4')?.cameraId).toBeNull();
  });

  it('plays the first camera when there is no wide shot', () => {
    const { project } = setup([[0, 10]], [], 10, false);
    expect(soundSources({ ...project, mics: [] }).filter((source) => !source.muted).map((source) => source.path)).toEqual(['camA.mp4']);
  });

  it('still cuts between speakers using the cameras’ own audio', () => {
    const { project, envelopes } = setup([[0, 20]], [[20, 40]], 40);
    const cameraOnly = { ...project, mics: [] };
    const byCamera = new Map([
      ['camera-audio:camA', envelopes.get('micA')!],
      ['camera-audio:camB', envelopes.get('micB')!]
    ]);
    const shots = planShots(cameraOnly, byCamera);
    expect(cameraAt(shots, 10)).toBe('camA');
    expect(cameraAt(shots, 30)).toBe('camB');
  });

  it('uses the real mics as soon as there are any', () => {
    const { project } = setup([[0, 10]], [], 10);
    expect(soundSources(project)).toBe(project.mics);
  });
});

describe('smoothActivity', () => {
  it('bridges short gaps and drops blips', () => {
    const input = Uint8Array.from([1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(Array.from(smoothActivity(input, 2, 3))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('findOffset', () => {
  const talk: Talk[] = [];
  for (let time = 0; time < 600; time += 7) {
    talk.push([time, time + 3 + (time % 5)]);
  }
  const reference = envelope(voice(600, talk, 7), null, 8);

  it('finds a file that started recording later', () => {
    const start = Math.round(12.34 * ENVELOPE_RATE);
    // Quieter, noisier copy of the same sound, like a camera's built-in mic.
    const random = rng(99);
    const other = reference.slice(start, start + 400 * ENVELOPE_RATE).map((value) => value * 0.3 + random() * 0.003);
    const result = findOffset(reference, other);
    expect(result.offsetSec).toBeCloseTo(12.34, 1);
    expect(result.confidence).toBeGreaterThan(1.5);
  });

  it('finds a file that started recording earlier', () => {
    const random = rng(5);
    const lead = Float32Array.from({ length: 5 * ENVELOPE_RATE }, () => 0.001 + random() * 0.002);
    const other = new Float32Array(lead.length + reference.length);
    other.set(lead);
    other.set(reference, lead.length);
    const result = findOffset(reference, other);
    expect(result.offsetSec).toBeCloseTo(-5, 1);
  });
});
