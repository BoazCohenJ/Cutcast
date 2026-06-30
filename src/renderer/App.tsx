import { useMemo, useState } from 'react';

type MediaSource = {
  id: string;
  kind: 'audio' | 'video';
  path: string;
  label: string;
  offsetSec: number;
};

type CameraFeed = {
  id: string;
  name: string;
  videoPath: string;
  videoOffsetSec: number;
  sources: MediaSource[];
};

type OverrideBlock = {
  id: string;
  cameraId: string;
  startSec: number;
  endSec: number;
};

const createId = () => Math.random().toString(36).slice(2, 10);
const formatSeconds = (value: number) => `${value.toFixed(1)}s`;
const inferMediaKind = (filePath: string): MediaSource['kind'] => (filePath.match(/\.(mp4|mov|mkv|webm)$/i) ? 'video' : 'audio');

export default function App() {
  const [cameras, setCameras] = useState<CameraFeed[]>([]);
  const [overrides, setOverrides] = useState<OverrideBlock[]>([]);
  const [outputPath, setOutputPath] = useState('');
  const [status, setStatus] = useState('Ready. Add a camera to begin.');
  const [helpOpen, setHelpOpen] = useState(false);

  const totalDurationSec = useMemo(() => {
    const allVideoOffsets = cameras.map((camera) => camera.videoOffsetSec);
    const allAudioOffsets = cameras.flatMap((camera) => camera.sources.map((source) => source.offsetSec));
    return Math.max(0, ...allVideoOffsets, ...allAudioOffsets);
  }, [cameras]);

  const addCamera = async () => {
    const mediaPaths = await window.desktopApi.openMediaFiles();
    if (!mediaPaths.length) {
      return;
    }

    const nextCamera = mediaPaths[0];
    setCameras((current) => [
      ...current,
      {
        id: createId(),
        name: `Camera ${current.length + 1}`,
        videoPath: nextCamera,
        videoOffsetSec: 0,
        sources: [
          {
            id: createId(),
            kind: inferMediaKind(nextCamera),
            path: nextCamera,
            label: 'Primary source',
            offsetSec: 0
          } satisfies MediaSource
        ]
      }
    ]);
    setStatus('Camera added. Use the bars below to line up the clips.');
  };

  const addAudioToCamera = async (cameraId: string) => {
    const mediaPaths = await window.desktopApi.openMediaFiles();
    if (!mediaPaths.length) {
      return;
    }

    setCameras((current) =>
      current.map((camera) =>
        camera.id === cameraId
          ? {
              ...camera,
              sources: [
                ...camera.sources,
                ...mediaPaths.map((mediaPath): MediaSource => ({
                  id: createId(),
                  kind: inferMediaKind(mediaPath),
                  path: mediaPath,
                  label: `Mic ${camera.sources.length + 1}`,
                  offsetSec: 0
                }))
              ]
            }
          : camera
      )
    );
    setStatus('Audio source linked to the camera.');
  };

  const chooseOutput = async () => {
    const filePath = await window.desktopApi.chooseSaveFile();
    if (filePath) {
      setOutputPath(filePath);
      setStatus(`Output file selected: ${filePath}`);
    }
  };

  const exportVideo = async () => {
    if (!outputPath) {
      setStatus('Pick an output file first.');
      return;
    }

    setStatus('Exporting. This can take a bit on longer clips.');
    try {
      const exportedPath = await window.desktopApi.exportProject({ cameras, overrides, totalDurationSec, outputPath });
      setStatus(`Export finished: ${exportedPath}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed.');
    }
  };

  const updateCamera = (cameraId: string, patch: Partial<CameraFeed>) => {
    setCameras((current) => current.map((camera) => (camera.id === cameraId ? { ...camera, ...patch } : camera)));
  };

  const updateSource = (cameraId: string, sourceId: string, patch: Partial<MediaSource>) => {
    setCameras((current) =>
      current.map((camera) =>
        camera.id === cameraId
          ? {
              ...camera,
              sources: camera.sources.map((source) => (source.id === sourceId ? { ...source, ...patch } : source))
            }
          : camera
      )
    );
  };

  const removeCamera = (cameraId: string) => {
    setCameras((current) => current.filter((camera) => camera.id !== cameraId));
    setOverrides((current) => current.filter((override) => override.cameraId !== cameraId));
  };

  const addOverride = () => {
    const firstCamera = cameras[0];
    if (!firstCamera) {
      setStatus('Add a camera before creating a manual override.');
      return;
    }

    setOverrides((current) => [
      ...current,
      {
        id: createId(),
        cameraId: firstCamera.id,
        startSec: 0,
        endSec: 10
      }
    ]);
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Local desktop editor</p>
          <h1>Podcast Autocut</h1>
          <p className="lede">
            Add one camera per row, link any number of mic or video files to it, line them up on the native timeline,
            and export one finished MP4.
          </p>
        </div>
        <div className="hero-actions">
          <button className="secondary" onClick={() => void window.desktopApi.showHelp()}>
            Simple guide
          </button>
          <button onClick={addCamera}>Add camera</button>
        </div>
      </header>

      <section className="status-bar">
        <span>{status}</span>
        <span>{cameras.length} cameras</span>
        <span>{formatSeconds(totalDurationSec)}</span>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-header">
            <h2>Timeline</h2>
            <div className="panel-actions">
              <button className="secondary" onClick={addOverride}>Force camera section</button>
              <button className="secondary" onClick={chooseOutput}>Pick save location</button>
              <button onClick={exportVideo}>Make video</button>
            </div>
          </div>

          <div className="timeline-ruler">
            {Array.from({ length: 13 }).map((_, index) => (
              <span key={index}>{index * 10}s</span>
            ))}
          </div>

          <div className="camera-list">
            {cameras.map((camera, cameraIndex) => (
              <article className="camera-card" key={camera.id}>
                <div className="camera-topline">
                  <input
                    className="camera-name"
                    value={camera.name}
                    onChange={(event) => updateCamera(camera.id, { name: event.target.value })}
                  />
                  <div className="camera-buttons">
                    <button className="secondary" onClick={() => void addAudioToCamera(camera.id)}>
                      Add sound file
                    </button>
                    <button className="danger" onClick={() => removeCamera(camera.id)}>
                      Remove
                    </button>
                  </div>
                </div>

                <div className="camera-meta">
                  <span>{camera.videoPath}</span>
                </div>

                <div className="clip-strip">
                  <label>
                    Video offset {formatSeconds(camera.videoOffsetSec)}
                    <input
                      type="range"
                      min="0"
                      max="300"
                      step="0.5"
                      value={camera.videoOffsetSec}
                      onChange={(event) => updateCamera(camera.id, { videoOffsetSec: Number(event.target.value) })}
                    />
                  </label>

                  {camera.sources.map((source, sourceIndex) => (
                    <div className="source-row" key={source.id}>
                      <input
                        value={source.label}
                        onChange={(event) => updateSource(camera.id, source.id, { label: event.target.value })}
                      />
                      <span>{source.kind}</span>
                      <input
                        type="range"
                        min="0"
                        max="300"
                        step="0.5"
                        value={source.offsetSec}
                        onChange={(event) => updateSource(camera.id, source.id, { offsetSec: Number(event.target.value) })}
                      />
                      <span>{formatSeconds(source.offsetSec)}</span>
                      <span className="source-path">{source.path}</span>
                      <span className="source-order">#{cameraIndex + 1}.{sourceIndex + 1}</span>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>

        <aside className="panel narrow">
          <h2>Manual override</h2>
          <p className="help-copy">
            Use this when you want one camera to stay on screen for a section. Otherwise the app follows the loudest
            linked sound track.
          </p>

          {overrides.map((override) => (
            <div className="override-row" key={override.id}>
              <select
                value={override.cameraId}
                onChange={(event) =>
                  setOverrides((current) =>
                    current.map((item) => (item.id === override.id ? { ...item, cameraId: event.target.value } : item))
                  )
                }
              >
                {cameras.map((camera) => (
                  <option key={camera.id} value={camera.id}>
                    {camera.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                step="0.5"
                value={override.startSec}
                onChange={(event) =>
                  setOverrides((current) =>
                    current.map((item) => (item.id === override.id ? { ...item, startSec: Number(event.target.value) } : item))
                  )
                }
              />
              <input
                type="number"
                min="0"
                step="0.5"
                value={override.endSec}
                onChange={(event) =>
                  setOverrides((current) =>
                    current.map((item) => (item.id === override.id ? { ...item, endSec: Number(event.target.value) } : item))
                  )
                }
              />
            </div>
          ))}

          <button className="secondary full-width" onClick={() => setHelpOpen(true)}>
            Open simple guide
          </button>
        </aside>
      </section>

      {helpOpen ? (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="help-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Simple guide</h2>
            <ol>
              <li>Add one camera for each angle you want.</li>
              <li>Attach one or more sound files or video files to that camera.</li>
              <li>Move the sliders until the clips line up.</li>
              <li>Use the force-camera section if you want a camera to stay on screen.</li>
              <li>Pick where to save it, then click Make video.</li>
            </ol>
            <button onClick={() => setHelpOpen(false)}>Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
