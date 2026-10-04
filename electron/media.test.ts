import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFfmpeg } from './ffmpeg';
import { analyzeMedia } from './media';

describe('analyzeMedia', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cutcast-'));
    file = path.join(dir, 'two-mics.mkv');
    // A video with two audio tracks: a tone on the first, silence on the second.
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'sine=f=440:d=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-f', 'lavfi', '-i', 'color=red:s=64x64:d=2',
      '-map', '2:v', '-map', '0:a', '-map', '1:a', '-t', '2',
      '-c:v', 'libx264', '-c:a', 'aac',
      '-metadata:s:a:0', 'title=Host mic',
      file
    ]);
  }, 30000);

  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('reads every audio track separately', async () => {
    const analysis = await analyzeMedia(file, path.join(dir, 'cache'), () => undefined);
    expect(analysis.hasVideo).toBe(true);
    expect(analysis.audioTracks).toEqual([{ title: 'Host mic', layout: 'mono' }, { layout: 'stereo' }]);
    expect(analysis.envelopes).toHaveLength(2);
    const loudness = analysis.envelopes.map((envelope) => Math.max(...envelope));
    expect(loudness[0]).toBeGreaterThan(0.05); // lavfi sine plays at 1/8 amplitude
    expect(loudness[1]).toBe(0);

    const cached = await analyzeMedia(file, path.join(dir, 'cache'), () => undefined);
    expect(cached.envelopes.map((envelope) => Array.from(envelope))).toEqual(analysis.envelopes.map((envelope) => Array.from(envelope)));
  }, 30000);
});
