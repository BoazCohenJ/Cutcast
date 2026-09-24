import { useEffect, useRef, useState } from 'react';
import { soundSources, type Project, type Shot, type Track } from '../../shared/types';
import { dbToGain, formatTime, mediaUrl } from '../lib/util';

type Props = {
  project: Project;
  shots: Shot[];
  duration: number;
  playhead: number;
  playing: boolean;
  onTime: (seconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
};

const REASON_LABEL: Record<Shot['reason'], string> = {
  speaker: 'Speaking',
  crosstalk: 'Crosstalk',
  silence: 'Pause',
  cutaway: 'Wide cutaway',
  override: 'Your choice',
  fallback: 'Only camera available'
};

export function shotAt(shots: Shot[], time: number) {
  let low = 0;
  let high = shots.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (time < shots[mid].startSec) {
      high = mid - 1;
    } else if (time >= shots[mid].endSec) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

const localTime = (track: Track, time: number) => time - track.offsetSec;
const inRange = (track: Track, time: number) => {
  const local = localTime(track, time);
  return local >= 0 && local < (track.info?.durationSec ?? 0) - 0.05;
};

export function Preview({ project, shots, duration, playhead, playing, onTime, onPlayingChange }: Props) {
  const elements = useRef(new Map<string, HTMLMediaElement>());
  const lastEmitted = useRef(playhead);
  const clock = useRef({ wall: 0, time: 0 });
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  const sources = soundSources(project);
  const tracks: Track[] = [...project.cameras, ...sources];
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const mics = useRef(sources);
  mics.current = sources;

  const register = (id: string) => (element: HTMLMediaElement | null) => {
    if (element) {
      elements.current.set(id, element);
    } else {
      elements.current.delete(id);
    }
  };

  /** Point every element at `time`; while playing, only correct ones that drifted. */
  const syncElements = (time: number, isPlaying: boolean, skip?: string) => {
    for (const track of tracksRef.current) {
      const element = elements.current.get(track.id);
      if (!element || track.id === skip) {
        continue;
      }
      if (!inRange(track, time)) {
        if (!element.paused) {
          element.pause();
        }
        continue;
      }
      const target = localTime(track, time);
      const tolerance = isPlaying ? (element instanceof HTMLVideoElement ? 0.12 : 0.2) : 0.01;
      if (Math.abs(element.currentTime - target) > tolerance) {
        element.currentTime = target;
      }
      if (isPlaying && element.paused) {
        void element.play().catch(() => undefined);
      } else if (!isPlaying && !element.paused) {
        element.pause();
      }
    }
  };

  // Paused: follow the playhead (scrubbing, seeking from the timeline).
  useEffect(() => {
    if (!playing) {
      lastEmitted.current = playhead;
      syncElements(playhead, false);
    } else if (Math.abs(playhead - lastEmitted.current) > 0.05) {
      // Someone seeked while playing.
      clock.current = { wall: performance.now(), time: playhead };
      lastEmitted.current = playhead;
      syncElements(playhead, true);
    }
  });

  // Playing: run the clock, slaved to a microphone when one is playing so the sound stays smooth.
  useEffect(() => {
    if (!playing) {
      for (const element of elements.current.values()) {
        element.pause();
      }
      return;
    }

    clock.current = { wall: performance.now(), time: lastEmitted.current >= duration - 0.05 ? 0 : lastEmitted.current };
    syncElements(clock.current.time, true);
    let frame = 0;

    const tick = () => {
      let time = clock.current.time + (performance.now() - clock.current.wall) / 1000;
      const master = mics.current.find((mic) => !mic.muted && inRange(mic, time));
      const masterElement = master ? elements.current.get(master.id) : undefined;
      if (master && masterElement && !masterElement.paused && !masterElement.seeking && masterElement.readyState >= 3) {
        const masterTime = masterElement.currentTime + master.offsetSec;
        // Trust the mic unless it's wildly off (e.g. it just started).
        if (Math.abs(masterTime - time) < 0.3) {
          time = masterTime;
          clock.current = { wall: performance.now(), time };
        }
      }

      if (time >= duration) {
        lastEmitted.current = duration;
        onTime(duration);
        onPlayingChange(false);
        return;
      }

      syncElements(time, true, master?.id && masterElement && !masterElement.paused ? master.id : undefined);
      lastEmitted.current = time;
      onTime(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);

  const current = shotAt(shots, playhead);
  const shot = current >= 0 ? shots[current] : undefined;
  const activeCamera = project.cameras.find((camera) => camera.id === shot?.cameraId);
  const activeFailed = activeCamera && failed[activeCamera.id];
  const cameraVisible = activeCamera && inRange(activeCamera, playhead);

  return (
    <div className="preview">
      <div className="preview-screen">
        {project.cameras.map((camera) => (
          <video
            key={camera.id}
            ref={register(camera.id)}
            src={mediaUrl(camera.path)}
            className={camera.id === activeCamera?.id && cameraVisible ? 'visible' : ''}
            muted
            playsInline
            preload="auto"
            onError={() => setFailed((current) => ({ ...current, [camera.id]: true }))}
          />
        ))}
        {sources.map((mic) => (
          <audio
            key={mic.id}
            ref={(element) => {
              register(mic.id)(element);
              if (element) {
                element.volume = Math.min(1, dbToGain(mic.volumeDb));
                element.muted = mic.muted;
              }
            }}
            src={mediaUrl(mic.path)}
            preload="auto"
          />
        ))}

        {!project.cameras.length ? <div className="preview-message">Add a camera to see the preview</div> : null}
        {activeFailed ? (
          <div className="preview-message">
            The preview can’t play {activeCamera.name}’s format. The export will still include it.
          </div>
        ) : null}
        {shot && !activeCamera ? <div className="preview-message">No camera covers this moment (exports as black)</div> : null}

        {activeCamera ? (
          <div className="preview-badge">
            <span className="swatch" style={{ background: activeCamera.color }} />
            {activeCamera.name}
            {shot ? <span className="reason">{REASON_LABEL[shot.reason]}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="transport">
        <button className="icon" title="Previous cut ( [ )" onClick={() => onTime(shots[Math.max(0, current - (shot && playhead - shot.startSec < 0.3 ? 1 : 0))]?.startSec ?? 0)}>
          ⏮
        </button>
        <button className="icon play" title="Play / pause (Space)" onClick={() => onPlayingChange(!playing)} disabled={duration <= 0}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="icon" title="Next cut ( ] )" onClick={() => current + 1 < shots.length && onTime(shots[current + 1].startSec)}>
          ⏭
        </button>
        <span className="timecode">
          {formatTime(playhead)} <span className="muted">/ {formatTime(duration)}</span>
        </span>
      </div>
    </div>
  );
}
