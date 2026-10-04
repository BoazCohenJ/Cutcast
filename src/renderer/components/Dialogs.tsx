import { useEffect, useRef, useState } from 'react';
import type { ExportProgress, MediaAnalysis } from '../../shared/types';
import { audioTrackName } from '../lib/projectOps';
import { fileName } from '../lib/util';

export type ExportState =
  | { status: 'running'; progress: ExportProgress; outputPath: string }
  | { status: 'done'; outputPath: string }
  | { status: 'error'; message: string };

function useEta(progress: number | undefined) {
  const started = useRef(performance.now());
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (progress === undefined || progress < 0.02) {
    return null;
  }
  const elapsed = (now - started.current) / 1000;
  const remaining = (elapsed / progress) * (1 - progress);
  return remaining < 60 ? 'less than a minute left' : `about ${Math.round(remaining / 60)} min left`;
}

export function ExportDialog({ state, onCancel, onClose, onReveal }: { state: ExportState; onCancel: () => void; onClose: () => void; onReveal: (path: string) => void }) {
  const eta = useEta(state.status === 'running' ? state.progress.progress : undefined);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        {state.status === 'running' ? (
          <>
            <h2>Making your video</h2>
            <p className="muted">{fileName(state.outputPath)}</p>
            <div className="progress large"><div style={{ width: `${(state.progress.progress * 100).toFixed(1)}%` }} /></div>
            <div className="progress-caption">
              <span>{state.progress.message}</span>
              <span>{Math.floor(state.progress.progress * 100)}%{eta ? ` · ${eta}` : ''}</span>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={onCancel}>Cancel</button>
            </div>
          </>
        ) : null}
        {state.status === 'done' ? (
          <>
            <h2>Your video is ready 🎉</h2>
            <p className="muted">{state.outputPath}</p>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>Close</button>
              <button onClick={() => onReveal(state.outputPath)}>Show in folder</button>
            </div>
          </>
        ) : null}
        {state.status === 'error' ? (
          <>
            <h2>The export didn’t finish</h2>
            <p className="error-text">{state.message}</p>
            <div className="modal-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['← →', 'Back / forward 1 second (Shift: 5 seconds)'],
  ['[  ]', 'Previous / next cut'],
  ['1 – 9', 'Lock that camera for the current shot'],
  ['0', 'Let the app choose again for the current shot'],
  ['I  O', 'Set export start / end at the playhead'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+S', 'Save project']
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(event) => event.stopPropagation()}>
        <h2>How it works</h2>
        <ol className="steps">
          <li><strong>Drop in all your files</strong>: every camera video and every microphone recording. The app sorts them and lines them up by their sound.</li>
          <li><strong>Check who’s who.</strong> Each mic should point at the camera that films that person. Set your wide camera to “Wide shot”.</li>
          <li><strong>Press play.</strong> The preview switches cameras the way the export will. Don’t like a shot? Press a camera number to lock it.</li>
          <li><strong>Export.</strong> Every mic plays the whole time; only the picture changes.</li>
        </ol>
        <h3>Keyboard</h3>
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map(([keys, action]) => (
              <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}

/** Asked on import for files that carry several audio tracks (e.g. one per mic): which tracks become mics. */
export function AudioTrackDialog({ files, onDone }: { files: Array<{ path: string; analysis: MediaAnalysis }>; onDone: (micTracks: Map<string, number[]>) => void }) {
  const [picked, setPicked] = useState(() => new Map(files.map(({ path, analysis }) => [path, (analysis.audioTracks ?? []).map((_, index) => index)])));
  const toggle = (path: string, track: number, on: boolean) =>
    setPicked((current) => {
      const others = (current.get(path) ?? []).filter((item) => item !== track);
      return new Map(current).set(path, on ? [...others, track].sort((a, b) => a - b) : others);
    });

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Which audio tracks are mics?</h2>
        <div className="muted">Each track you tick becomes its own microphone.</div>
        {files.map(({ path, analysis }) => (
          <div key={path}>
            <h3>{fileName(path)}</h3>
            {(analysis.audioTracks ?? []).map((track, index) => (
              <label className="check" key={index}>
                <input type="checkbox" checked={picked.get(path)?.includes(index) ?? false} onChange={(event) => toggle(path, index, event.target.checked)} />
                {audioTrackName(analysis, index)}
                {track.layout ? <span className="muted small">{track.layout}</span> : null}
              </label>
            ))}
            <div className="muted small">
              {analysis.hasVideo ? 'Untick them all to use this camera’s own sound instead.' : 'Untick them all to leave this file out.'}
            </div>
          </div>
        ))}
        <div className="modal-actions">
          <button onClick={() => onDone(picked)}>Add</button>
        </div>
      </div>
    </div>
  );
}
