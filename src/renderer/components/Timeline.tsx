import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { waveformBuckets } from '../../shared/cutEngine';
import type { Camera, Mic, Project, Shot } from '../../shared/types';
import type { Analyses } from '../lib/projectOps';
import { formatTime } from '../lib/util';

type Props = {
  project: Project;
  shots: Shot[];
  analyses: Analyses;
  duration: number;
  playhead: number;
  playing: boolean;
  selectedShot: number;
  onSeek: (seconds: number) => void;
  onSelectShot: (index: number) => void;
  onOffsetDrag: (trackId: string, offsetSec: number, phase: 'start' | 'move' | 'end') => void;
};

type Row =
  | { kind: 'ruler'; height: number }
  | { kind: 'cuts'; height: number }
  | { kind: 'track'; height: number; track: Camera | Mic; isCamera: boolean };

const RULER = 26;
const CUTS = 40;
const TRACK = 46;
const MAX_PX_PER_SEC = 400;
const TICKS = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function Timeline(props: Props) {
  const { project, shots, analyses, duration, playhead, playing, selectedShot } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(1);
  const userZoomed = useRef(false);
  const callbacks = useRef(props);
  callbacks.current = props;

  const rows = useMemo<Row[]>(
    () => [
      { kind: 'ruler', height: RULER },
      { kind: 'cuts', height: CUTS },
      ...project.cameras.map((track): Row => ({ kind: 'track', height: TRACK, track, isCamera: true })),
      ...project.mics.map((track): Row => ({ kind: 'track', height: TRACK, track, isCamera: false }))
    ],
    [project.cameras, project.mics]
  );
  const height = rows.reduce((sum, row) => sum + row.height, 0);
  const fitPx = duration > 0 ? width / duration : 1;
  const px = Math.max(fitPx, Math.min(MAX_PX_PER_SEC, pxPerSec));
  const viewStart = scrollLeft / px;
  const contentWidth = Math.max(width, duration * px);

  const cameraColor = (cameraId: string | null | undefined) =>
    project.cameras.find((camera) => camera.id === cameraId)?.color ?? '#6b7280';

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Stay zoomed to fit until the user zooms themselves.
  useEffect(() => {
    if (!userZoomed.current) {
      setPxPerSec(fitPx);
    }
  }, [fitPx]);

  const zoomTo = (next: number, anchorX = width / 2) => {
    const clamped = Math.max(fitPx, Math.min(MAX_PX_PER_SEC, next));
    const anchorTime = (scrollLeft + anchorX) / px;
    userZoomed.current = clamped > fitPx * 1.001;
    setPxPerSec(clamped);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollLeft = anchorTime * clamped - anchorX;
      }
    });
  };

  // Keep the playhead in view while playing.
  useEffect(() => {
    const element = scrollRef.current;
    if (!playing || !element) {
      return;
    }
    const x = playhead * px - element.scrollLeft;
    if (x < 0 || x > width - 40) {
      element.scrollLeft = playhead * px - width * 0.1;
    }
  }, [playhead, playing, px, width]);

  // Base layer: ruler, cuts, tracks and waveforms.
  useEffect(() => {
    const canvas = baseRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const toX = (time: number) => (time - viewStart) * px;
    const viewEnd = viewStart + width / px;
    const colors = { bg: css('--tl-bg'), row: css('--tl-row'), line: css('--line'), text: css('--muted'), strong: css('--text') };

    context.fillStyle = colors.bg;
    context.fillRect(0, 0, width, height);
    context.font = '11px "Segoe UI", system-ui, sans-serif';
    context.textBaseline = 'middle';

    let y = 0;
    rows.forEach((row, index) => {
      if (row.kind === 'track' && index % 2 === 0) {
        context.fillStyle = colors.row;
        context.fillRect(0, y, width, row.height);
      }

      if (row.kind === 'ruler') {
        const interval = TICKS.find((tick) => tick * px >= 90) ?? 3600;
        context.fillStyle = colors.text;
        context.strokeStyle = colors.line;
        context.beginPath();
        for (let tick = Math.floor(viewStart / interval) * interval; tick <= viewEnd; tick += interval) {
          const x = Math.round(toX(tick)) + 0.5;
          context.moveTo(x, row.height - 8);
          context.lineTo(x, row.height);
          context.fillText(formatTime(tick, interval < 1), x + 4, row.height / 2 - 1);
        }
        context.stroke();
      }

      if (row.kind === 'cuts') {
        shots.forEach((shot, shotIndex) => {
          if (shot.endSec < viewStart || shot.startSec > viewEnd) {
            return;
          }
          const x = toX(shot.startSec);
          const w = Math.max(1, toX(shot.endSec) - x);
          context.fillStyle = shot.cameraId ? cameraColor(shot.cameraId) : '#111';
          context.globalAlpha = shot.reason === 'fallback' ? 0.45 : 0.9;
          context.fillRect(x, y + 6, w - 1, row.height - 12);
          context.globalAlpha = 1;
          if (shot.reason === 'override') {
            context.fillStyle = '#fff';
            context.fillRect(x, y + 6, w - 1, 3);
          }
          if (shotIndex === selectedShot) {
            context.strokeStyle = '#fff';
            context.lineWidth = 2;
            context.strokeRect(x + 1, y + 7, w - 3, row.height - 14);
            context.lineWidth = 1;
          }
          if (w > 70) {
            const name = project.cameras.find((camera) => camera.id === shot.cameraId)?.name ?? 'Black';
            context.fillStyle = '#111';
            context.fillText(name, x + 6, y + row.height / 2, w - 12);
          }
        });
      }

      if (row.kind === 'track') {
        const { track } = row;
        const trackDuration = track.info?.durationSec ?? 0;
        const color = row.isCamera ? (track as Camera).color : cameraColor((track as Mic).cameraId);
        const x0 = toX(track.offsetSec);
        const x1 = toX(track.offsetSec + trackDuration);
        const top = y + 5;
        const barHeight = row.height - 10;
        if (x1 > 0 && x0 < width) {
          context.fillStyle = color;
          context.globalAlpha = 0.16;
          context.fillRect(x0, top, x1 - x0, barHeight);
          context.globalAlpha = 1;
          context.strokeStyle = color;
          context.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.round(x1 - x0) - 1, barHeight - 1);

          const envelope = analyses.get(track.path)?.envelope;
          if (envelope?.length) {
            const from = Math.max(0, x0);
            const to = Math.min(width, x1);
            const buckets = Math.max(1, Math.floor((to - from) / 2));
            const levels = waveformBuckets(
              envelope,
              viewStart + from / px - track.offsetSec,
              viewStart + to / px - track.offsetSec,
              buckets
            );
            const mid = top + barHeight / 2;
            context.fillStyle = color;
            context.globalAlpha = (track as Mic).muted ? 0.3 : 0.85;
            for (let bucket = 0; bucket < buckets; bucket += 1) {
              const h = Math.max(1, levels[bucket] * (barHeight - 6));
              context.fillRect(from + bucket * 2, mid - h / 2, 1.5, h);
            }
            context.globalAlpha = 1;
          }
        }
      }

      y += row.height;
      context.fillStyle = colors.line;
      context.fillRect(0, y - 1, width, 1);
    });

    // Dim everything outside the export range.
    const shade = (from: number, to: number) => {
      const x = Math.max(0, toX(from));
      const end = Math.min(width, toX(to));
      if (end > x) {
        context.fillStyle = 'rgba(0,0,0,0.5)';
        context.fillRect(x, RULER, end - x, height - RULER);
      }
    };
    if (project.inSec !== null) {
      shade(0, project.inSec);
    }
    if (project.outSec !== null) {
      shade(project.outSec, duration);
    }
    // Not redrawn on playhead moves; the overlay handles those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, viewStart, px, rows, shots, analyses, project, selectedShot, duration]);

  // Overlay layer: just the playhead, cheap to redraw every frame.
  useEffect(() => {
    const canvas = overlayRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const x = Math.round((playhead - viewStart) * px) + 0.5;
    context.strokeStyle = '#ef4444';
    context.fillStyle = '#ef4444';
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
    context.beginPath();
    context.moveTo(x - 6, 0);
    context.lineTo(x + 6, 0);
    context.lineTo(x, 8);
    context.fill();
  }, [playhead, viewStart, px, width, height]);

  const hit = (event: { clientX: number; clientY: number }) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const yPos = event.clientY - rect.top;
    const time = Math.max(0, Math.min(duration, viewStart + x / px));
    let y = 0;
    for (const row of rows) {
      if (yPos >= y && yPos < y + row.height) {
        return { x, time, row };
      }
      y += row.height;
    }
    return { x, time, row: undefined };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const { time, row } = hit(event);
    const { onSeek, onSelectShot, onOffsetDrag } = callbacks.current;

    if (row?.kind === 'track') {
      const { track } = row;
      const onBar = time >= track.offsetSec && time <= track.offsetSec + (track.info?.durationSec ?? 0);
      if (onBar) {
        const startX = event.clientX;
        const startOffset = track.offsetSec;
        let offset = startOffset;
        onOffsetDrag(track.id, startOffset, 'start');
        const move = (moveEvent: PointerEvent) => {
          // Hold Shift for fine adjustment.
          const scale = moveEvent.shiftKey ? 0.1 : 1;
          offset = startOffset + ((moveEvent.clientX - startX) / px) * scale;
          callbacks.current.onOffsetDrag(track.id, offset, 'move');
        };
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
          callbacks.current.onOffsetDrag(track.id, offset, 'end');
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
        return;
      }
    }

    if (row?.kind === 'cuts') {
      const index = shots.findIndex((shot) => time >= shot.startSec && time < shot.endSec);
      onSelectShot(index);
    }
    onSeek(time);
    const move = (moveEvent: PointerEvent) => callbacks.current.onSeek(hit(moveEvent).time);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const [cursor, setCursor] = useState('default');
  const onHover = (event: React.PointerEvent) => {
    if (event.buttons) {
      return;
    }
    const { time, row } = hit(event);
    const onBar =
      row?.kind === 'track' && time >= row.track.offsetSec && time <= row.track.offsetSec + (row.track.info?.durationSec ?? 0);
    setCursor(onBar ? 'grab' : row?.kind === 'cuts' ? 'pointer' : 'text');
  };

  const onWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey || event.metaKey || !event.shiftKey) {
      // Plain wheel zooms (the usual in editors); Shift+wheel scrolls.
      const rect = scrollRef.current!.getBoundingClientRect();
      zoomTo(px * Math.pow(1.0015, -event.deltaY), event.clientX - rect.left);
    }
  };

  useEffect(() => {
    // React's wheel listener is passive; block the page's own scroll-on-wheel here.
    const element = scrollRef.current;
    const block = (event: WheelEvent) => {
      if (!event.shiftKey) {
        event.preventDefault();
      }
    };
    element?.addEventListener('wheel', block, { passive: false });
    return () => element?.removeEventListener('wheel', block);
  }, []);

  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <span className="muted small">Scroll to zoom · Shift+scroll to pan · Drag a clip to nudge its sync (hold Shift for fine)</span>
        <div className="spacer" />
        <button className="ghost small" onClick={() => zoomTo(px / 2)}>−</button>
        <button className="ghost small" onClick={() => zoomTo(px * 2)}>+</button>
        <button className="ghost small" onClick={() => { userZoomed.current = false; setPxPerSec(fitPx); }}>Fit</button>
      </div>
      <div className="timeline-body">
        <div className="timeline-labels">
          {rows.map((row, index) => (
            <div key={index} className={`timeline-label ${row.kind}`} style={{ height: row.height }}>
              {row.kind === 'cuts' ? <strong>Program</strong> : null}
              {row.kind === 'track' ? (
                <>
                  <span className="swatch" style={{ background: row.isCamera ? (row.track as Camera).color : cameraColor((row.track as Mic).cameraId) }} />
                  <span className="label-text">
                    <span className="label-kind">{row.isCamera ? ((row.track as Camera).role === 'wide' ? 'Wide' : 'Cam') : 'Mic'}</span>
                    {row.track.name}
                  </span>
                </>
              ) : null}
            </div>
          ))}
        </div>
        <div className="timeline-scroll" ref={scrollRef} onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)} onWheel={onWheel}>
          <div style={{ width: contentWidth, height }}>
            <div className="timeline-canvases" style={{ width, height }}>
              <canvas ref={baseRef} style={{ width, height }} />
              <canvas
                ref={overlayRef}
                style={{ width, height, cursor }}
                onPointerDown={onPointerDown}
                onPointerMove={onHover}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
