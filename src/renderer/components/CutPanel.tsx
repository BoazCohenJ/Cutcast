import { DEFAULT_CUT, type CutSettings, type Override, type Project, type Shot } from '../../shared/types';
import { formatTime } from '../lib/util';

type Props = {
  project: Project;
  shots: Shot[];
  currentShot: number;
  onChangeCut: (patch: Partial<CutSettings>) => void;
  onForce: (cameraId: string | null) => void;
  onUpdateOverride: (id: string, patch: Partial<Override>) => void;
  onRemoveOverride: (id: string) => void;
  onSeek: (seconds: number) => void;
  playhead: number;
};

function Slider(props: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`slider ${props.disabled ? 'disabled' : ''}`} title={props.hint}>
      <div className="slider-top">
        <span>{props.label}</span>
        <span className="value">{props.format(props.value)}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <span className="hint">{props.hint}</span>
    </label>
  );
}

export function CutPanel({ project, shots, currentShot, onChangeCut, onForce, onUpdateOverride, onRemoveOverride, onSeek, playhead }: Props) {
  const { cut } = project;
  const hasWide = project.cameras.some((camera) => camera.role === 'wide');
  const shot = shots[currentShot];
  const override = shot ? project.overrides.find((item) => item.startSec <= shot.startSec + 1e-6 && item.endSec >= shot.endSec - 1e-6) : undefined;

  const total = shots.reduce((sum, item) => sum + item.endSec - item.startSec, 0);
  const share = project.cameras.map((camera) => ({
    camera,
    seconds: shots.filter((item) => item.cameraId === camera.id).reduce((sum, item) => sum + item.endSec - item.startSec, 0)
  }));

  return (
    <div className="panel-body">
      <h3>Current shot</h3>
      {shot ? (
        <div className="track-card">
          <div className="muted small">
            {formatTime(shot.startSec)} – {formatTime(shot.endSec)} ({(shot.endSec - shot.startSec).toFixed(1)}s)
          </div>
          <div className="camera-buttons">
            {project.cameras.map((camera, index) => (
              <button
                key={camera.id}
                className={shot.cameraId === camera.id ? 'chosen' : 'secondary'}
                style={{ borderColor: camera.color }}
                onClick={() => onForce(camera.id)}
                title={`Press ${index + 1}`}
              >
                <span className="swatch" style={{ background: camera.color }} /> {camera.name}
              </button>
            ))}
          </div>
          {override ? (
            <button className="ghost small" onClick={() => onForce(null)}>Undo my choice, let the app decide (0)</button>
          ) : (
            <p className="hint">Pick a camera to lock it for this shot. Keys 1–{Math.max(1, project.cameras.length)} do the same while playing.</p>
          )}
        </div>
      ) : (
        <p className="muted small">Add cameras and mics to see the cuts.</p>
      )}

      {project.overrides.length ? (
        <>
          <h3>Your choices</h3>
          {project.overrides.map((item) => {
            const camera = project.cameras.find((candidate) => candidate.id === item.cameraId);
            return (
              <div className="override-row" key={item.id}>
                <span className="swatch" style={{ background: camera?.color }} />
                <button className="link" onClick={() => onSeek(item.startSec)}>{camera?.name ?? '?'}</button>
                <button className="ghost small" title="Start at playhead" onClick={() => onUpdateOverride(item.id, { startSec: Math.min(playhead, item.endSec - 0.1) })}>
                  {formatTime(item.startSec)}
                </button>
                <span className="muted">–</span>
                <button className="ghost small" title="End at playhead" onClick={() => onUpdateOverride(item.id, { endSec: Math.max(playhead, item.startSec + 0.1) })}>
                  {formatTime(item.endSec)}
                </button>
                <button className="ghost icon" title="Remove" onClick={() => onRemoveOverride(item.id)}>✕</button>
              </div>
            );
          })}
          <p className="hint">Click a time to move that edge to the playhead.</p>
        </>
      ) : null}

      <h3>Cutting style</h3>
      <Slider
        label="Voice sensitivity"
        hint="Raise it if quiet talkers get missed; lower it if breathing or room noise causes cuts."
        value={cut.sensitivity}
        min={0}
        max={1}
        step={0.05}
        format={(value) => `${Math.round(value * 100)}%`}
        onChange={(sensitivity) => onChangeCut({ sensitivity })}
      />
      <Slider
        label="Shortest shot"
        hint="The camera never switches faster than this. Longer feels calmer."
        value={cut.minShotSec}
        min={1}
        max={8}
        step={0.5}
        format={(value) => `${value}s`}
        onChange={(minShotSec) => onChangeCut({ minShotSec })}
      />
      <label className="check">
        <input type="checkbox" checked={cut.wideOnCrosstalk} disabled={!hasWide} onChange={(event) => onChangeCut({ wideOnCrosstalk: event.target.checked })} />
        Go wide when people talk over each other
      </label>
      <Slider
        label="Go wide after a pause of"
        hint="Cut to the wide shot when nobody has spoken for this long."
        value={cut.wideAfterSilenceSec}
        min={0}
        max={15}
        step={0.5}
        disabled={!hasWide}
        format={(value) => (value === 0 ? 'Off' : `${value}s`)}
        onChange={(wideAfterSilenceSec) => onChangeCut({ wideAfterSilenceSec })}
      />
      <Slider
        label="Break up long close-ups every"
        hint="Drops in a short wide shot during long monologues, at a natural pause."
        value={cut.maxCloseupSec}
        min={0}
        max={120}
        step={5}
        disabled={!hasWide}
        format={(value) => (value === 0 ? 'Off' : `${value}s`)}
        onChange={(maxCloseupSec) => onChangeCut({ maxCloseupSec })}
      />
      <Slider
        label="Wide cutaway length"
        hint="How long those wide cutaways last."
        value={cut.wideCutawaySec}
        min={2}
        max={10}
        step={0.5}
        disabled={!hasWide || cut.maxCloseupSec === 0}
        format={(value) => `${value}s`}
        onChange={(wideCutawaySec) => onChangeCut({ wideCutawaySec })}
      />
      <Slider
        label="Crosstalk detection"
        hint="Two mics within this many dB of their normal speaking level count as talking together."
        value={cut.crosstalkDb}
        min={2}
        max={14}
        step={1}
        format={(value) => `${value} dB`}
        onChange={(crosstalkDb) => onChangeCut({ crosstalkDb })}
      />
      {!hasWide ? <p className="hint">Wide-shot options switch on once a camera is set to “Wide shot”.</p> : null}
      <button className="ghost small" onClick={() => onChangeCut({ ...DEFAULT_CUT })}>Reset to defaults</button>

      {shots.length ? (
        <>
          <h3>Summary</h3>
          <div className="stats">
            <div><strong>{shots.length}</strong><span>shots</span></div>
            <div><strong>{(total / Math.max(1, shots.length)).toFixed(1)}s</strong><span>average</span></div>
          </div>
          <div className="share-bar">
            {share.map(({ camera, seconds }) => (
              <div key={camera.id} style={{ flex: seconds, background: camera.color }} title={`${camera.name}: ${Math.round((100 * seconds) / (total || 1))}%`} />
            ))}
          </div>
          <div className="share-legend">
            {share.map(({ camera, seconds }) => (
              <span key={camera.id}><span className="swatch" style={{ background: camera.color }} />{camera.name} {Math.round((100 * seconds) / (total || 1))}%</span>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
