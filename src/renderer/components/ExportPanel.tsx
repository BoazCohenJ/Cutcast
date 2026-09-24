import { exportRange, type OutputSettings, type Project } from '../../shared/types';
import { formatDuration, formatTime } from '../lib/util';

type Props = {
  project: Project;
  playhead: number;
  encoders: string[];
  onChangeOutput: (patch: Partial<OutputSettings>) => void;
  onSetRange: (patch: Partial<Pick<Project, 'inSec' | 'outSec'>>) => void;
  onExport: () => void;
};

const SIZES = [
  [3840, 2160],
  [2560, 1440],
  [1920, 1080],
  [1280, 720]
];

const QUALITIES = [
  { value: 17, label: 'Best (large file)' },
  { value: 20, label: 'High' },
  { value: 23, label: 'Balanced' },
  { value: 27, label: 'Small file' }
];

const ENCODER_NAMES: Record<string, string> = {
  libx264: 'Processor (works everywhere)',
  h264_nvenc: 'NVIDIA graphics (fast)',
  h264_qsv: 'Intel graphics (fast)',
  h264_amf: 'AMD graphics (fast)'
};

export function ExportPanel({ project, playhead, encoders, onChangeOutput, onSetRange, onExport }: Props) {
  const { output } = project;
  const range = exportRange(project);
  const sizes = SIZES.some(([w, h]) => w === output.width && h === output.height) ? SIZES : [[output.width, output.height], ...SIZES];

  return (
    <div className="panel-body">
      <h3>What to include</h3>
      <div className="range-row">
        <span>Start</span>
        <strong>{formatTime(range.start)}</strong>
        <button className="ghost small" onClick={() => onSetRange({ inSec: playhead })}>Set to playhead (I)</button>
        {project.inSec !== null ? <button className="ghost icon" title="Clear" onClick={() => onSetRange({ inSec: null })}>✕</button> : null}
      </div>
      <div className="range-row">
        <span>End</span>
        <strong>{formatTime(range.end)}</strong>
        <button className="ghost small" onClick={() => onSetRange({ outSec: playhead })}>Set to playhead (O)</button>
        {project.outSec !== null ? <button className="ghost icon" title="Clear" onClick={() => onSetRange({ outSec: null })}>✕</button> : null}
      </div>
      <p className="hint">Trim off the chat before you hit record and after you say goodbye.</p>

      <h3>Video</h3>
      <label className="field-row">
        <span>Size</span>
        <select
          value={`${output.width}x${output.height}`}
          onChange={(event) => {
            const [width, height] = event.target.value.split('x').map(Number);
            onChangeOutput({ width, height });
          }}
        >
          {sizes.map(([w, h]) => (
            <option key={`${w}x${h}`} value={`${w}x${h}`}>{h >= 2160 ? '4K' : `${h}p`} ({w}×{h})</option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>Frame rate</span>
        <select value={output.fps} onChange={(event) => onChangeOutput({ fps: Number(event.target.value) })}>
          {[24, 25, 30, 50, 60].map((fps) => (
            <option key={fps} value={fps}>{fps} fps</option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>Quality</span>
        <select value={output.quality} onChange={(event) => onChangeOutput({ quality: Number(event.target.value) })}>
          {QUALITIES.some((item) => item.value === output.quality) ? null : <option value={output.quality}>Custom ({output.quality})</option>}
          {QUALITIES.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <label className="field-row">
        <span>Encode with</span>
        <select value={output.encoder} onChange={(event) => onChangeOutput({ encoder: event.target.value as OutputSettings['encoder'] })}>
          {(encoders.includes(output.encoder) ? encoders : [output.encoder, ...encoders]).map((encoder) => (
            <option key={encoder} value={encoder}>{ENCODER_NAMES[encoder] ?? encoder}</option>
          ))}
        </select>
      </label>

      <h3>Sound</h3>
      <label className="check">
        <input type="checkbox" checked={output.normalizeLoudness} onChange={(event) => onChangeOutput({ normalizeLoudness: event.target.checked })} />
        Even out loudness to podcast standard (−16 LUFS)
      </label>
      <p className="hint">All microphones marked “In mix” play the whole time. Only the picture switches.</p>

      <button className="export-button" onClick={onExport} disabled={!project.cameras.length || range.end <= range.start}>
        Export video · {formatDuration(range.end - range.start)}
      </button>
    </div>
  );
}
