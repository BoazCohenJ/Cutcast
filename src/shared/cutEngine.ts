import { ENVELOPE_RATE, soundSources, type Camera, type Mic, type Project, type Shot, timelineDuration, trackEnd } from './types';

/** Decisions are made on a 10 Hz grid. */
export const STEP_SEC = 0.1;

type Envelopes = ReadonlyMap<string, Float32Array>;

type MicActivity = {
  mic: Mic;
  /** Loudness in dB per step, NaN where the mic has no audio on the timeline. */
  db: Float32Array;
  /** Loudness relative to this mic's own speech level (makes differently-gained mics comparable). */
  rel: Float32Array;
  thresholdDb: number;
};

const toDb = (energy: number) => 10 * Math.log10(energy + 1e-10);

function percentile(values: number[], p: number) {
  if (!values.length) {
    return -100;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Resample one mic's envelope onto the timeline grid in dB. */
export function micLoudness(envelope: Float32Array, offsetSec: number, steps: number) {
  const db = new Float32Array(steps).fill(NaN);
  const perStep = ENVELOPE_RATE * STEP_SEC;

  for (let step = 0; step < steps; step += 1) {
    const from = Math.round((step * STEP_SEC - offsetSec) * ENVELOPE_RATE);
    const to = from + perStep;
    if (to <= 0 || from >= envelope.length) {
      continue;
    }
    let energy = 0;
    let count = 0;
    for (let index = Math.max(0, from); index < Math.min(envelope.length, to); index += 1) {
      energy += envelope[index] * envelope[index];
      count += 1;
    }
    db[step] = toDb(energy / count);
  }

  return db;
}

/** A mic's own speech is assumed to peak within this many dB of the loudest mic's (gain-staged recordings). */
const MAX_GAIN_SPREAD_DB = 6;

function analyzeMics(mics: Mic[], envelopes: Envelopes, steps: number, sensitivity: number): MicActivity[] {
  const measured = mics.map((mic) => {
    const db = micLoudness(envelopes.get(mic.id)!, mic.offsetSec, steps);
    const valid = Array.from(db).filter((value) => !Number.isNaN(value));
    // Low percentile for the floor: even a non-stop talker has breaths and gaps between words.
    return { mic, db, floor: percentile(valid, 0.05), speech: percentile(valid, 0.99) };
  });
  const loudest = Math.max(...measured.map((item) => item.speech));

  return measured.map(({ mic, db, floor, speech }) => {
    // A mic that only ever hears the others (bleed) would otherwise treat that bleed as its speaking level.
    const reference = Math.max(speech, loudest - MAX_GAIN_SPREAD_DB);
    const range = Math.max(12, reference - floor);
    // sensitivity 0 → 60% of the way from noise floor to speech, 1 → 20%.
    const thresholdDb = floor + range * (0.6 - 0.4 * Math.min(1, Math.max(0, sensitivity)));
    return { mic, db, rel: db.map((value) => value - reference), thresholdDb };
  });
}

/** Fill gaps shorter than `maxGap` steps, then drop runs shorter than `minRun` steps. */
export function smoothActivity(active: Uint8Array, maxGap: number, minRun: number) {
  const out = Uint8Array.from(active);
  let lastOn = -1;
  for (let index = 0; index < out.length; index += 1) {
    if (out[index]) {
      if (lastOn >= 0 && index - lastOn > 1 && index - lastOn - 1 <= maxGap) {
        out.fill(1, lastOn + 1, index);
      }
      lastOn = index;
    }
  }

  let runStart = -1;
  for (let index = 0; index <= out.length; index += 1) {
    const on = index < out.length && out[index] === 1;
    if (on && runStart < 0) {
      runStart = index;
    } else if (!on && runStart >= 0) {
      if (index - runStart < minRun) {
        out.fill(0, runStart, index);
      }
      runStart = -1;
    }
  }
  return out;
}

const isAvailable = (camera: Camera, startSec: number, endSec: number) =>
  camera.info !== undefined && startSec >= camera.offsetSec - 1e-6 && endSec <= trackEnd(camera) + 1e-6;

function mergeSame(shots: Shot[]) {
  const merged: Shot[] = [];
  for (const shot of shots) {
    if (shot.endSec - shot.startSec <= 1e-6) {
      continue;
    }
    const previous = merged[merged.length - 1];
    // Manual choices stay their own shots so they can be seen and undone.
    const sameKind = (previous?.reason === 'override') === (shot.reason === 'override');
    if (previous && sameKind && previous.cameraId === shot.cameraId && Math.abs(previous.endSec - shot.startSec) < 1e-6) {
      previous.endSec = shot.endSec;
      // A shot that opens on a breath is still a speaker shot.
      if (previous.reason === 'silence') {
        previous.reason = shot.reason;
      }
    } else {
      merged.push({ ...shot });
    }
  }
  return merged;
}

/** Absorb shots shorter than `minShotSec` into a neighbour, shortest first. */
function enforceMinShot(input: Shot[], minShotSec: number, cameras: Map<string, Camera>) {
  type Working = Shot & { stuck?: boolean };
  let shots: Working[] = mergeSame(input);
  const canShow = (neighbour: Working | undefined, shot: Working): neighbour is Working => {
    const camera = neighbour?.cameraId ? cameras.get(neighbour.cameraId) : undefined;
    return camera !== undefined && isAvailable(camera, shot.startSec, shot.endSec);
  };
  const length = (shot: Working) => shot.endSec - shot.startSec;

  while (shots.length > 1) {
    let shortest = -1;
    for (let index = 0; index < shots.length; index += 1) {
      const shot = shots[index];
      if (!shot.stuck && length(shot) < minShotSec - 1e-6 && (shortest < 0 || length(shot) < length(shots[shortest]))) {
        shortest = index;
      }
    }
    if (shortest < 0) {
      break;
    }

    const shot = shots[shortest];
    const before = shots[shortest - 1];
    const after = shots[shortest + 1];
    let target: Working | undefined;
    if (canShow(before, shot) && canShow(after, shot)) {
      // Joining both sides removes two cuts at once; otherwise keep the longer neighbour on screen.
      target = before.cameraId === after.cameraId || length(before) >= length(after) ? before : after;
    } else if (canShow(before, shot)) {
      target = before;
    } else if (canShow(after, shot)) {
      target = after;
    }

    if (!target) {
      shots[shortest] = { ...shot, stuck: true };
      continue;
    }
    shots[shortest] = { ...shot, cameraId: target.cameraId, reason: target.reason };
    shots = mergeSame(shots);
  }

  return shots.map(({ stuck: _stuck, ...shot }) => shot);
}

/** Split long close-ups with a wide cutaway, placed at the quietest moment near evenly spaced targets. */
function insertCutaways(shots: Shot[], project: Project, wide: Camera | undefined, activity: MicActivity[]) {
  const { maxCloseupSec, wideCutawaySec, minShotSec } = project.cut;
  if (!wide || maxCloseupSec <= 0 || wideCutawaySec <= 0) {
    return shots;
  }

  const result: Shot[] = [];
  for (const shot of shots) {
    const length = shot.endSec - shot.startSec;
    if (shot.reason !== 'speaker' || shot.cameraId === wide.id || length <= maxCloseupSec) {
      result.push(shot);
      continue;
    }

    const count = Math.floor(length / maxCloseupSec);
    let cursor = shot.startSec;
    for (let index = 1; index <= count; index += 1) {
      const target = shot.startSec + (length * index) / (count + 1) - wideCutawaySec / 2;
      const start = quietestStart(activity, target, cursor + minShotSec, shot.endSec - minShotSec - wideCutawaySec);
      if (start === null || !isAvailable(wide, start, start + wideCutawaySec)) {
        continue;
      }
      result.push({ ...shot, startSec: cursor, endSec: start });
      result.push({ startSec: start, endSec: start + wideCutawaySec, cameraId: wide.id, reason: 'cutaway' });
      cursor = start + wideCutawaySec;
    }
    result.push({ ...shot, startSec: cursor });
  }
  return result;
}

function quietestStart(activity: MicActivity[], target: number, min: number, max: number) {
  if (max < min) {
    return null;
  }
  const from = Math.max(min, target - 5);
  const to = Math.min(max, target + 5);
  if (to < from) {
    return Math.min(max, Math.max(min, target));
  }

  let best = from;
  let bestScore = Infinity;
  for (let start = from; start <= to; start += STEP_SEC) {
    // Loudest moment at the cut point: we'd rather cut in a breath.
    const step = Math.round(start / STEP_SEC);
    let score = -Infinity;
    for (const mic of activity) {
      const value = mic.db[step];
      if (!Number.isNaN(value)) {
        score = Math.max(score, value);
      }
    }
    score += Math.abs(start - target) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return Math.round(best / STEP_SEC) * STEP_SEC;
}

function applyOverrides(shots: Shot[], project: Project, duration: number) {
  let result = shots;
  for (const override of project.overrides) {
    const start = Math.max(0, Math.min(override.startSec, override.endSec));
    const end = Math.min(duration, Math.max(override.startSec, override.endSec));
    if (end - start <= 0) {
      continue;
    }
    const next: Shot[] = [];
    for (const shot of result) {
      if (shot.endSec <= start || shot.startSec >= end) {
        next.push(shot);
        continue;
      }
      if (shot.startSec < start) {
        next.push({ ...shot, endSec: start });
      }
      if (shot.endSec > end) {
        next.push({ ...shot, startSec: end });
      }
    }
    next.push({ startSec: start, endSec: end, cameraId: override.cameraId, reason: 'override' });
    next.sort((a, b) => a.startSec - b.startSec);
    result = next;
  }
  return result;
}

/** Make sure every shot's camera actually has footage; otherwise swap in wide / any camera / black. */
function applyAvailability(shots: Shot[], cameras: Camera[], wide: Camera | undefined) {
  const boundaries = new Set<number>();
  for (const camera of cameras) {
    boundaries.add(camera.offsetSec);
    boundaries.add(trackEnd(camera));
  }
  const cuts = [...boundaries].sort((a, b) => a - b);

  const result: Shot[] = [];
  for (const shot of shots) {
    const points = [shot.startSec, ...cuts.filter((point) => point > shot.startSec && point < shot.endSec), shot.endSec];
    for (let index = 0; index < points.length - 1; index += 1) {
      const piece = { ...shot, startSec: points[index], endSec: points[index + 1] };
      const camera = cameras.find((item) => item.id === piece.cameraId);
      if (!camera || !isAvailable(camera, piece.startSec, piece.endSec)) {
        const fallback = [wide, ...cameras].find((item) => item && isAvailable(item, piece.startSec, piece.endSec));
        piece.cameraId = fallback?.id ?? null;
        piece.reason = 'fallback';
      }
      result.push(piece);
    }
  }
  return mergeSame(result);
}

/** Decide which camera is on screen for every moment of the timeline. */
export function planShots(project: Project, envelopes: Envelopes): Shot[] {
  const duration = timelineDuration(project);
  const cameras = project.cameras.filter((camera) => camera.info?.hasVideo);
  if (!cameras.length || duration <= 0) {
    return [];
  }

  const cameraMap = new Map(cameras.map((camera) => [camera.id, camera]));
  const wide = cameras.find((camera) => camera.role === 'wide');
  const steps = Math.ceil(duration / STEP_SEC);
  const { cut } = project;

  const activity = analyzeMics(
    soundSources(project).filter((mic) => envelopes.has(mic.id)),
    envelopes,
    steps,
    cut.sensitivity
  );

  const smoothed = activity.map((mic) => {
    const raw = new Uint8Array(steps);
    for (let step = 0; step < steps; step += 1) {
      let loudestRel = -Infinity;
      for (const other of activity) {
        if (other.db[step] > other.thresholdDb) {
          loudestRel = Math.max(loudestRel, other.rel[step]);
        }
      }
      raw[step] = mic.db[step] > mic.thresholdDb && mic.rel[step] >= loudestRel - cut.crosstalkDb ? 1 : 0;
    }
    return smoothActivity(raw, Math.round(0.8 / STEP_SEC), Math.round(0.4 / STEP_SEC));
  });

  const cameraAt = (cameraId: string | null, step: number) => {
    const camera = cameraId ? cameraMap.get(cameraId) : undefined;
    const time = step * STEP_SEC;
    return camera && isAvailable(camera, time, time + STEP_SEC) ? camera.id : null;
  };
  const wideAt = (step: number) => (wide ? cameraAt(wide.id, step) : null);

  const perStep: Shot[] = [];
  let current: string | null = null;
  let silentSteps = 0;

  for (let step = 0; step < steps; step += 1) {
    const talking = activity.filter((_, index) => smoothed[index][step]);
    let next: string | null = null;
    let reason: Shot['reason'] = 'speaker';

    if (talking.length === 1) {
      silentSteps = 0;
      next = cameraAt(talking[0].mic.cameraId, step) ?? wideAt(step) ?? cameraAt(current, step);
    } else if (talking.length > 1) {
      silentSteps = 0;
      reason = 'crosstalk';
      const loudest = [...talking].sort((a, b) => b.rel[step] - a.rel[step])[0];
      const currentIsTalking = talking.some((mic) => mic.mic.cameraId === current);
      next =
        (cut.wideOnCrosstalk ? wideAt(step) : null) ??
        (currentIsTalking ? cameraAt(current, step) : null) ??
        cameraAt(loudest.mic.cameraId, step) ??
        cameraAt(current, step);
    } else {
      silentSteps += 1;
      reason = 'silence';
      const longSilence = cut.wideAfterSilenceSec > 0 && silentSteps * STEP_SEC >= cut.wideAfterSilenceSec;
      next = (longSilence ? wideAt(step) : null) ?? cameraAt(current, step);
    }

    next ??= wideAt(step) ?? cameras.find((camera) => cameraAt(camera.id, step))?.id ?? null;
    current = next;
    perStep.push({
      startSec: step * STEP_SEC,
      endSec: Math.min(duration, (step + 1) * STEP_SEC),
      cameraId: next,
      reason
    });
  }

  let shots = mergeSame(perStep);
  shots = enforceMinShot(shots, cut.minShotSec, cameraMap);
  shots = insertCutaways(shots, project, wide, activity);
  shots = applyOverrides(shots, project, duration);
  shots = applyAvailability(shots, cameras, wide);
  return shots;
}

/** Envelope levels for drawing waveforms: returns peak dB-normalized 0..1 per pixel bucket. */
export function waveformBuckets(envelope: Float32Array, fromSec: number, toSec: number, buckets: number) {
  const out = new Float32Array(buckets);
  const span = (toSec - fromSec) / buckets;
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = Math.floor((fromSec + bucket * span) * ENVELOPE_RATE);
    const to = Math.max(from + 1, Math.floor((fromSec + (bucket + 1) * span) * ENVELOPE_RATE));
    let peak = 0;
    for (let index = Math.max(0, from); index < Math.min(envelope.length, to); index += 1) {
      peak = Math.max(peak, envelope[index]);
    }
    // Map -60dB..0dB to 0..1 so quiet speech is still visible.
    out[bucket] = peak > 0 ? Math.max(0, 1 + toDb(peak * peak) / 60) : 0;
  }
  return out;
}
