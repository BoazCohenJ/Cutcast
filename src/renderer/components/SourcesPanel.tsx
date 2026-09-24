import type { Camera, Mic, Project, Track } from '../../shared/types';
import { fileName, formatTime } from '../lib/util';

type Props = {
  project: Project;
  importing: Record<string, number>;
  errors: Record<string, string>;
  syncing: boolean;
  onAddFiles: () => void;
  onAutoSync: () => void;
  onUpdate: (id: string, patch: Partial<Camera> & Partial<Mic>) => void;
  onRemove: (id: string) => void;
  onRelink: (track: Track) => void;
};

function TrackDetails({ track, error, onRelink }: { track: Track; error?: string; onRelink: () => void }) {
  const info = track.info;
  if (error) {
    return (
      <div className="track-error">
        <span>{error}</span>
        <button className="small" onClick={onRelink}>Locate file…</button>
      </div>
    );
  }
  const parts = [fileName(track.path)];
  if (info?.width && info.height) {
    parts.push(`${info.width}×${info.height}`);
  }
  if (info?.fps) {
    parts.push(`${Math.round(info.fps * 100) / 100} fps`);
  }
  if (info) {
    parts.push(formatTime(info.durationSec, false));
  }
  return <div className="track-meta" title={track.path}>{parts.join(' · ')}</div>;
}

function OffsetControl({ track, onUpdate }: { track: Track; onUpdate: Props['onUpdate'] }) {
  const set = (value: number) => onUpdate(track.id, { offsetSec: Math.round(value * 1000) / 1000 });
  const doubtful = track.syncConfidence !== undefined && track.syncConfidence < 1.5;
  return (
    <div className="offset-row">
      <span className="muted small">Starts at</span>
      <button className="ghost small" title="Earlier by 1 frame" onClick={() => set(track.offsetSec - 1 / 30)}>‹</button>
      <input
        type="number"
        step="0.01"
        value={Number(track.offsetSec.toFixed(3))}
        onChange={(event) => set(Number(event.target.value) || 0)}
      />
      <button className="ghost small" title="Later by 1 frame" onClick={() => set(track.offsetSec + 1 / 30)}>›</button>
      <span className="muted small">s</span>
      {doubtful ? (
        <span className="warn small" title="Auto-sync wasn't sure about this one. Play it back and nudge it if the lips don't match.">
          ⚠ check sync
        </span>
      ) : null}
    </div>
  );
}

export function SourcesPanel({ project, importing, errors, syncing, onAddFiles, onAutoSync, onUpdate, onRemove, onRelink }: Props) {
  const importingPaths = Object.keys(importing);
  const trackCount = project.cameras.length + project.mics.length;

  return (
    <div className="panel-body">
      <div className="button-row">
        <button onClick={onAddFiles}>Add files…</button>
        <button className="secondary" onClick={onAutoSync} disabled={trackCount < 2 || syncing}>
          {syncing ? 'Syncing…' : 'Auto-sync'}
        </button>
      </div>

      {importingPaths.map((path) => (
        <div className="importing" key={path}>
          <span>{fileName(path)}</span>
          <div className="progress"><div style={{ width: `${Math.round(importing[path] * 100)}%` }} /></div>
        </div>
      ))}

      <h3>Cameras</h3>
      {!project.cameras.length ? <p className="muted small">No cameras yet. Add your video files.</p> : null}
      {project.cameras.map((camera, index) => (
        <div className="track-card" key={camera.id}>
          <div className="track-title">
            <span className="swatch" style={{ background: camera.color }} />
            <span className="key-hint" title={`Press ${index + 1} to force this camera`}>{index + 1}</span>
            <input value={camera.name} onChange={(event) => onUpdate(camera.id, { name: event.target.value })} />
            <select value={camera.role} onChange={(event) => onUpdate(camera.id, { role: event.target.value as Camera['role'] })}>
              <option value="speaker">Close-up</option>
              <option value="wide">Wide shot</option>
            </select>
            <button className="ghost icon" title="Remove" onClick={() => onRemove(camera.id)}>✕</button>
          </div>
          <TrackDetails track={camera} error={errors[camera.path]} onRelink={() => onRelink(camera)} />
          <OffsetControl track={camera} onUpdate={onUpdate} />
        </div>
      ))}

      <h3>Microphones</h3>
      {!project.mics.length ? <p className="muted small">No microphones yet. Add each person’s audio file.</p> : null}
      {project.mics.map((mic) => (
        <div className={`track-card ${mic.muted ? 'dimmed' : ''}`} key={mic.id}>
          <div className="track-title">
            <span className="swatch" style={{ background: project.cameras.find((camera) => camera.id === mic.cameraId)?.color ?? '#6b7280' }} />
            <input value={mic.name} onChange={(event) => onUpdate(mic.id, { name: event.target.value })} />
            <button className="ghost icon" title="Remove" onClick={() => onRemove(mic.id)}>✕</button>
          </div>
          <TrackDetails track={mic} error={errors[mic.path]} onRelink={() => onRelink(mic)} />
          <label className="field-row">
            <span>When talking, show</span>
            <select value={mic.cameraId ?? ''} onChange={(event) => onUpdate(mic.id, { cameraId: event.target.value || null })}>
              <option value="">No close-up (use wide)</option>
              {project.cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>{camera.name}</option>
              ))}
            </select>
          </label>
          <div className="field-row">
            <span>Volume</span>
            <input
              type="range"
              min="-20"
              max="12"
              step="0.5"
              value={mic.volumeDb}
              onChange={(event) => onUpdate(mic.id, { volumeDb: Number(event.target.value) })}
            />
            <span className="value">{mic.volumeDb > 0 ? '+' : ''}{mic.volumeDb} dB</span>
            <label className="check" title="Leave this mic out of the final sound (it still drives the cuts)">
              <input type="checkbox" checked={!mic.muted} onChange={(event) => onUpdate(mic.id, { muted: !event.target.checked })} />
              In mix
            </label>
          </div>
          <OffsetControl track={mic} onUpdate={onUpdate} />
        </div>
      ))}
    </div>
  );
}
