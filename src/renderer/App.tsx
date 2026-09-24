import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { planShots } from '../shared/cutEngine';
import { emptyProject, exportRange, timelineDuration, type MediaAnalysis, type Project, type Track } from '../shared/types';
import { CutPanel } from './components/CutPanel';
import { ExportDialog, HelpDialog, type ExportState } from './components/Dialogs';
import { ExportPanel } from './components/ExportPanel';
import { Preview, shotAt } from './components/Preview';
import { SourcesPanel } from './components/SourcesPanel';
import { Timeline } from './components/Timeline';
import { addFiles, allTracks, autoSync, removeTrack, setOverride, updateTrack } from './lib/projectOps';
import { useHistory } from './lib/useHistory';
import { fileName, stripExtension } from './lib/util';

const api = window.desktopApi;
type Tab = 'sources' | 'cuts' | 'export';

/** ipcRenderer wraps errors as "Error invoking remote method 'x': Error: message". */
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export default function App() {
  const history = useHistory<Project>(emptyProject());
  const project = history.state;
  const setProject = history.set;
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [savedProject, setSavedProject] = useState<Project>(project);
  const [analyses, setAnalyses] = useState<ReadonlyMap<string, MediaAnalysis>>(new Map());
  const [importing, setImporting] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>('sources');
  const [encoders, setEncoders] = useState<string[]>(['libx264']);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const restored = useRef(false);
  const [ready, setReady] = useState(false);

  const duration = timelineDuration(project);
  const dirty = project !== savedProject && allTracks(project).length > 0;

  const micEnvelopes = useMemo(() => {
    const map = new Map<string, Float32Array>();
    for (const mic of project.mics) {
      const envelope = analyses.get(mic.path)?.envelope;
      if (envelope?.length) {
        map.set(mic.id, envelope);
      }
    }
    return map;
  }, [project.mics, analyses]);

  const shots = useMemo(() => planShots(project, micEnvelopes), [project, micEnvelopes]);
  const currentShot = shotAt(shots, Math.min(playhead, Math.max(0, duration - 1e-3)));

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  /** Analyse files (cached on disk after the first time) and keep their info and loudness envelopes. */
  const analyzePaths = useCallback(async (paths: string[]) => {
    setImporting((current) => ({ ...current, ...Object.fromEntries(paths.map((path) => [path, 0])) }));
    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          const analysis = await api.analyze(path);
          setErrors(({ [path]: _removed, ...rest }) => rest);
          return { path, analysis };
        } catch (error) {
          setErrors((current) => ({ ...current, [path]: errorMessage(error) }));
          return null;
        } finally {
          setImporting(({ [path]: _done, ...rest }) => rest);
        }
      })
    );
    const ok = results.filter((result): result is { path: string; analysis: MediaAnalysis } => result !== null);
    const next = new Map(analyses);
    for (const { path, analysis } of ok) {
      next.set(path, analysis);
    }
    setAnalyses((current) => {
      const merged = new Map(current);
      ok.forEach(({ path, analysis }) => merged.set(path, analysis));
      return merged;
    });
    return { ok, all: next };
  }, [analyses]);

  const importFiles = useCallback(async (paths: string[]) => {
    const known = new Set(allTracks(history.ref.current).map((track) => track.path));
    const fresh = [...new Set(paths)].filter((path) => !known.has(path));
    if (!fresh.length) {
      return;
    }
    const { ok, all } = await analyzePaths(fresh);
    const skipped = ok.filter(({ analysis }) => !analysis.hasVideo && !analysis.hasAudio);
    if (skipped.length) {
      showToast(`${skipped.map(({ path }) => fileName(path)).join(', ')} has no video or sound.`);
    }
    if (!ok.length) {
      return;
    }

    setSyncing(true);
    // Let the "Syncing…" state paint before the (brief) number crunching.
    await new Promise((resolve) => setTimeout(resolve, 30));
    setProject((current) => {
      const before = new Set(allTracks(current).map((track) => track.id));
      const withFiles = addFiles(current, ok);
      const added = new Set(allTracks(withFiles).map((track) => track.id).filter((id) => !before.has(id)));
      return allTracks(withFiles).length > 1 ? autoSync(withFiles, all, before.size ? added : undefined) : withFiles;
    });
    setSyncing(false);
    setTab('sources');
  }, [analyzePaths, history.ref, setProject, showToast]);

  const loadProject = useCallback(async (next: Project, path: string | null, markSaved: boolean) => {
    history.reset(next);
    setProjectPath(path);
    setSavedProject(markSaved ? next : emptyProject());
    setPlayhead(0);
    setPlaying(false);
    setErrors({});
    await analyzePaths([...new Set(allTracks(next).map((track) => track.path))]);
  }, [analyzePaths, history]);

  // Startup: restore the last session and find out which hardware encoders work.
  useEffect(() => {
    if (restored.current) {
      return;
    }
    restored.current = true;
    void api.encoders().then(setEncoders).catch(() => undefined);
    void api
      .restore()
      .then((session) => {
        if (session && allTracks(session.project).length) {
          void loadProject(session.project, session.projectPath, false);
          showToast('Picked up where you left off.');
        }
      })
      .finally(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => api.onAnalyzeProgress((path, fraction) => setImporting((current) => (path in current ? { ...current, [path]: fraction } : current))), []);

  // Autosave so a crash or accidental close never loses work.
  useEffect(() => {
    if (!ready) {
      // Don't overwrite the last session before it has been restored.
      return;
    }
    const timer = setTimeout(() => void api.autosave(project, projectPath), 800);
    return () => clearTimeout(timer);
  }, [project, projectPath, ready]);

  useEffect(() => {
    const name = projectPath ? stripExtension(fileName(projectPath)) : 'Untitled';
    document.title = `${name}${dirty ? ' •' : ''} · Cutcast`;
  }, [projectPath, dirty]);

  const save = useCallback(async (saveAs = false) => {
    const current = history.ref.current;
    try {
      const path = await api.saveProject(current, saveAs ? null : projectPath);
      if (path) {
        setProjectPath(path);
        setSavedProject(current);
        showToast('Project saved.');
      }
    } catch (error) {
      showToast(`Couldn’t save: ${errorMessage(error)}`);
    }
  }, [history.ref, projectPath, showToast]);

  const confirmDiscard = () => !dirty || window.confirm('You have unsaved changes. Continue without saving?');

  const openProject = async () => {
    if (!confirmDiscard()) {
      return;
    }
    try {
      const result = await api.openProject();
      if (result) {
        await loadProject(result.project, result.path, true);
      }
    } catch (error) {
      showToast(errorMessage(error));
    }
  };

  const newProject = () => {
    if (!confirmDiscard()) {
      return;
    }
    const fresh = emptyProject();
    history.reset(fresh);
    setSavedProject(fresh);
    setProjectPath(null);
    setPlayhead(0);
    setPlaying(false);
    setErrors({});
  };

  const addFilesFromDialog = async () => importFiles(await api.openMedia());

  const runAutoSync = async () => {
    setSyncing(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    setProject((current) => autoSync(current, analyses));
    setSyncing(false);
    showToast('Files lined up by their sound. Press play to check.');
  };

  const relink = async (track: Track) => {
    const [path] = await api.openMedia();
    if (!path) {
      return;
    }
    setProject((current) => ({
      ...current,
      cameras: current.cameras.map((camera) => (camera.path === track.path ? { ...camera, path } : camera)),
      mics: current.mics.map((mic) => (mic.path === track.path ? { ...mic, path } : mic))
    }));
    setErrors(({ [track.path]: _removed, ...rest }) => rest);
    await analyzePaths([path]);
  };

  const seek = useCallback((seconds: number) => setPlayhead(Math.max(0, Math.min(duration, seconds))), [duration]);

  const forceCamera = useCallback((cameraId: string | null) => {
    const shot = shots[currentShot];
    if (!shot) {
      return;
    }
    setProject((current) => setOverride(current, shot.startSec, shot.endSec, cameraId));
  }, [currentShot, setProject, shots]);

  const startExport = async () => {
    const current = history.ref.current;
    const range = exportRange(current);
    const suggested = `${projectPath ? stripExtension(fileName(projectPath)) : 'Podcast'}.mp4`;
    const outputPath = await api.chooseExportPath(suggested);
    if (!outputPath) {
      return;
    }
    setPlaying(false);
    setExportState({ status: 'running', outputPath, progress: { stage: 'video', progress: 0, message: 'Getting started' } });
    const unsubscribe = api.onExportProgress((progress) =>
      setExportState((state) => (state?.status === 'running' ? { ...state, progress } : state))
    );
    try {
      await api.startExport({ project: current, shots, startSec: range.start, endSec: range.end, outputPath });
      setExportState({ status: 'done', outputPath });
    } catch (error) {
      const message = errorMessage(error);
      setExportState(/cancelled/i.test(message) ? null : { status: 'error', message });
    } finally {
      unsubscribe();
    }
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (exportState || helpOpen || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
        return;
      }
      if (target.tagName === 'BUTTON' && event.key === ' ') {
        // Don't let Space both "click" the focused button and toggle playback.
        target.blur();
      }
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (ctrl && key === 'z' && !event.shiftKey) {
        history.undo();
      } else if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey))) {
        history.redo();
      } else if (ctrl && key === 's') {
        void save(event.shiftKey);
      } else if (ctrl && key === 'o') {
        void openProject();
      } else if (ctrl) {
        return;
      } else if (event.key === ' ') {
        setPlaying((value) => !value && duration > 0);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const step = (event.shiftKey ? 5 : 1) * (event.key === 'ArrowLeft' ? -1 : 1);
        seek(playhead + step);
      } else if (event.key === '[') {
        const shot = shots[currentShot];
        const index = shot && playhead - shot.startSec < 0.3 ? currentShot - 1 : currentShot;
        seek(shots[Math.max(0, index)]?.startSec ?? 0);
      } else if (event.key === ']') {
        const next = shots[currentShot + 1];
        if (next) {
          seek(next.startSec);
        }
      } else if (/^[1-9]$/.test(event.key)) {
        const camera = project.cameras[Number(event.key) - 1];
        if (camera) {
          forceCamera(camera.id);
        }
      } else if (event.key === '0') {
        forceCamera(null);
      } else if (key === 'i') {
        setProject((current) => ({ ...current, inSec: playhead }));
      } else if (key === 'o') {
        setProject((current) => ({ ...current, outSec: playhead }));
      } else if (event.key === 'Home') {
        seek(0);
      } else if (event.key === 'End') {
        seek(duration);
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Drag and drop files anywhere on the window.
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const projectFile = files.find((file) => file.name.toLowerCase().endsWith('.cutcast'));
    if (projectFile) {
      showToast('Use Open to load a project file.');
      return;
    }
    void importFiles(files.map((file) => api.pathForFile(file)).filter(Boolean));
  };

  const hasTracks = allTracks(project).length > 0;

  return (
    <div
      className="app"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <span className="logo">●</span> Cutcast
          <span className="project-name">
            {projectPath ? stripExtension(fileName(projectPath)) : 'Untitled'}
            {dirty ? ' •' : ''}
          </span>
        </div>
        <div className="topbar-actions">
          <button className="ghost" onClick={newProject}>New</button>
          <button className="ghost" onClick={() => void openProject()}>Open…</button>
          <button className="ghost" onClick={() => void save()} title="Ctrl+S">Save</button>
          <span className="divider" />
          <button className="ghost icon" onClick={history.undo} disabled={!history.canUndo} title="Undo (Ctrl+Z)">↶</button>
          <button className="ghost icon" onClick={history.redo} disabled={!history.canRedo} title="Redo (Ctrl+Y)">↷</button>
          <span className="divider" />
          <button className="ghost" onClick={() => setHelpOpen(true)}>Help</button>
          <button onClick={() => setTab('export')} disabled={!project.cameras.length}>Export</button>
        </div>
      </header>

      {hasTracks || Object.keys(importing).length ? (
        <>
          <main className="workspace">
            <section className="stage">
              <Preview
                project={project}
                shots={shots}
                duration={duration}
                playhead={playhead}
                playing={playing}
                onTime={setPlayhead}
                onPlayingChange={setPlaying}
              />
            </section>
            <aside className="sidebar">
              <nav className="tabs">
                <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>Files & sync</button>
                <button className={tab === 'cuts' ? 'active' : ''} onClick={() => setTab('cuts')}>Cuts</button>
                <button className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>Export</button>
              </nav>
              {tab === 'sources' ? (
                <SourcesPanel
                  project={project}
                  importing={importing}
                  errors={errors}
                  syncing={syncing}
                  onAddFiles={() => void addFilesFromDialog()}
                  onAutoSync={() => void runAutoSync()}
                  onUpdate={(id, patch) => setProject((current) => updateTrack(current, id, patch))}
                  onRemove={(id) => setProject((current) => removeTrack(current, id))}
                  onRelink={(track) => void relink(track)}
                />
              ) : null}
              {tab === 'cuts' ? (
                <CutPanel
                  project={project}
                  shots={shots}
                  currentShot={currentShot}
                  playhead={playhead}
                  onChangeCut={(patch) => setProject((current) => ({ ...current, cut: { ...current.cut, ...patch } }))}
                  onForce={forceCamera}
                  onUpdateOverride={(id, patch) =>
                    setProject((current) => ({ ...current, overrides: current.overrides.map((item) => (item.id === id ? { ...item, ...patch } : item)) }))
                  }
                  onRemoveOverride={(id) => setProject((current) => ({ ...current, overrides: current.overrides.filter((item) => item.id !== id) }))}
                  onSeek={seek}
                />
              ) : null}
              {tab === 'export' ? (
                <ExportPanel
                  project={project}
                  playhead={playhead}
                  encoders={encoders}
                  onChangeOutput={(patch) => setProject((current) => ({ ...current, output: { ...current.output, ...patch } }))}
                  onSetRange={(patch) => setProject((current) => ({ ...current, ...patch }))}
                  onExport={() => void startExport()}
                />
              ) : null}
            </aside>
          </main>
          <Timeline
            project={project}
            shots={shots}
            analyses={analyses}
            duration={duration}
            playhead={playhead}
            playing={playing}
            selectedShot={currentShot}
            onSeek={seek}
            onSelectShot={() => setTab('cuts')}
            onOffsetDrag={(id, offsetSec, phase) => {
              if (phase === 'start') {
                history.checkpoint();
              } else {
                setProject((current) => updateTrack(current, id, { offsetSec, syncConfidence: undefined }), { transient: true });
              }
            }}
          />
        </>
      ) : (
        <main className="welcome">
          <div className="drop-card">
            <div className="drop-icon">⬇</div>
            <h1>Drop your recordings here</h1>
            <p>All camera videos and microphone files from one episode. They get sorted and synced automatically.</p>
            <div className="button-row center">
              <button onClick={() => void addFilesFromDialog()}>Choose files…</button>
              <button className="secondary" onClick={() => void openProject()}>Open a project…</button>
            </div>
            <ol className="steps compact">
              <li>Add your cameras and mics</li>
              <li>Check the automatic cuts</li>
              <li>Export one finished video</li>
            </ol>
          </div>
        </main>
      )}

      {dragging ? <div className="drop-overlay">Drop to add files</div> : null}
      {toast ? <div className="toast">{toast}</div> : null}
      {helpOpen ? <HelpDialog onClose={() => setHelpOpen(false)} /> : null}
      {exportState ? (
        <ExportDialog
          state={exportState}
          onCancel={() => void api.cancelExport()}
          onClose={() => setExportState(null)}
          onReveal={(path) => void api.showItemInFolder(path)}
        />
      ) : null}
    </div>
  );
}
