import { ENVELOPE_RATE } from './types';

/** In-place iterative radix-2 FFT. `inverse` computes the unscaled inverse transform. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < size / 2; k += 1) {
        const a = start + k;
        const b = a + size / 2;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
}

/**
 * Turn a loudness envelope into a signal that emphasises speech rhythm (syllable onsets)
 * and ignores absolute gain, so a lapel mic and a camera's scratch mic still correlate.
 */
export function syncFeature(envelope: Float32Array) {
  const log = new Float64Array(envelope.length);
  for (let index = 0; index < envelope.length; index += 1) {
    log[index] = Math.log(envelope[index] + 1e-4);
  }

  const window = ENVELOPE_RATE; // 1s moving average as a high-pass
  const out = new Float64Array(envelope.length);
  let sum = 0;
  for (let index = 0; index < log.length; index += 1) {
    sum += log[index];
    if (index >= window) {
      sum -= log[index - window];
    }
    const mean = sum / Math.min(index + 1, window);
    out[index] = Math.max(0, log[index] - mean);
  }

  let mean = 0;
  for (const value of out) {
    mean += value;
  }
  mean /= out.length || 1;
  let variance = 0;
  for (let index = 0; index < out.length; index += 1) {
    out[index] -= mean;
    variance += out[index] * out[index];
  }
  const scale = Math.sqrt(variance / (out.length || 1)) || 1;
  for (let index = 0; index < out.length; index += 1) {
    out[index] /= scale;
  }
  return out;
}

function decimate(signal: Float64Array, factor: number) {
  const out = new Float64Array(Math.floor(signal.length / factor));
  for (let index = 0; index < out.length; index += 1) {
    let sum = 0;
    for (let k = 0; k < factor; k += 1) {
      sum += signal[index * factor + k];
    }
    out[index] = sum / factor;
  }
  return out;
}

/** Full cross-correlation c[L] = Σ a[n+L]·b[n]; returns values indexed by lag with lag = index - (b.length - 1). */
function crossCorrelate(a: Float64Array, b: Float64Array) {
  let size = 1;
  while (size < a.length + b.length) {
    size <<= 1;
  }
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(a);
  bRe.set(b);
  fft(aRe, aIm);
  fft(bRe, bIm);

  for (let index = 0; index < size; index += 1) {
    // A · conj(B)
    const re = aRe[index] * bRe[index] + aIm[index] * bIm[index];
    const im = aIm[index] * bRe[index] - aRe[index] * bIm[index];
    aRe[index] = re;
    aIm[index] = im;
  }
  fft(aRe, aIm, true);

  const lags = new Float64Array(a.length + b.length - 1);
  for (let lag = -(b.length - 1); lag < a.length; lag += 1) {
    lags[lag + b.length - 1] = aRe[(lag + size) % size] / size;
  }
  return lags;
}

function correlationAt(a: Float64Array, b: Float64Array, lag: number) {
  let sum = 0;
  const from = Math.max(0, -lag);
  const to = Math.min(b.length, a.length - lag);
  for (let n = from; n < to; n += 1) {
    sum += a[n + lag] * b[n];
  }
  return sum;
}

export type SyncResult = {
  /** Seconds to add to the reference track's offset to get this track's offset. */
  offsetSec: number;
  /** Peak-to-runner-up ratio; above ~1.5 is a trustworthy match. */
  confidence: number;
};

/**
 * Find where `other` starts relative to `reference`, using their loudness envelopes.
 * A positive result means `other` started recording later than `reference`.
 */
export function findOffset(reference: Float32Array, other: Float32Array): SyncResult {
  const a = syncFeature(reference);
  const b = syncFeature(other);
  if (a.length < ENVELOPE_RATE || b.length < ENVELOPE_RATE) {
    return { offsetSec: 0, confidence: 0 };
  }

  // Coarse search over every possible lag at 20 Hz.
  const factor = 5;
  const coarse = crossCorrelate(decimate(a, factor), decimate(b, factor));
  const coarseZero = Math.floor(b.length / factor) - 1;
  let peakIndex = 0;
  for (let index = 1; index < coarse.length; index += 1) {
    if (coarse[index] > coarse[peakIndex]) {
      peakIndex = index;
    }
  }

  // Runner-up peak at least 2s away tells us how unambiguous the match is.
  const exclusion = (2 * ENVELOPE_RATE) / factor;
  let runnerUp = 0;
  for (let index = 0; index < coarse.length; index += 1) {
    if (Math.abs(index - peakIndex) > exclusion) {
      runnerUp = Math.max(runnerUp, coarse[index]);
    }
  }
  const confidence = runnerUp > 0 ? coarse[peakIndex] / runnerUp : coarse[peakIndex] > 0 ? 10 : 0;

  // Refine at full resolution around the coarse peak, then interpolate between samples.
  const coarseLag = (peakIndex - coarseZero) * factor;
  let bestLag = coarseLag;
  let best = -Infinity;
  const values = new Map<number, number>();
  for (let lag = coarseLag - factor * 2; lag <= coarseLag + factor * 2; lag += 1) {
    const value = correlationAt(a, b, lag);
    values.set(lag, value);
    if (value > best) {
      best = value;
      bestLag = lag;
    }
  }
  const left = values.get(bestLag - 1) ?? correlationAt(a, b, bestLag - 1);
  const right = values.get(bestLag + 1) ?? correlationAt(a, b, bestLag + 1);
  const curvature = left - 2 * best + right;
  const fraction = curvature < 0 ? (0.5 * (left - right)) / curvature : 0;

  return { offsetSec: (bestLag + fraction) / ENVELOPE_RATE, confidence };
}
