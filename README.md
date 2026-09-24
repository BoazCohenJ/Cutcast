# Podcast Autocut

A local Windows app that turns a multi-camera podcast recording into one edited video. Drop in every camera and
microphone file; it lines them up by their sound, cuts to whoever is talking, and exports an MP4 with all the mics
mixed underneath.

## Using it

1. **Drop in your files**: every camera video and every mic recording from one episode. Videos become cameras, audio
   files become mics, and everything is auto-synced by matching the audio (files can start at different times).
2. **Check who's who** in *Files & sync*. Each mic should point at the camera that films that person. Set your wide
   camera to **Wide shot** (a camera with "wide" in its file name, or the third camera, is picked automatically).
3. **Press play.** The preview switches cameras exactly like the export will. Press `1`–`9` to lock a camera for the
   current shot, `0` to hand it back to the app. Tune the cutting style in the *Cuts* tab.
4. **Export.** Set start/end (`I` / `O`) to trim the pre-show chat, pick quality, and export.

Projects save as `.podcut` files, and the current session is autosaved and restored on the next launch.

### How the cuts are chosen

- Each mic's loudness is compared against its own noise floor and speaking level, so mic bleed and different gains
  don't cause false cuts.
- One person talking → their close-up. Several at once → wide shot. A long pause → wide shot.
- No shot is shorter than the *Shortest shot* setting; long monologues get a short wide cutaway at a natural pause.
- Your locked shots always win.

## Development

```bash
npm install
npm run dev        # Vite + Electron with hot reload
npm test           # cut engine and sync tests
npm run typecheck
npm run dist:win   # installer + portable .exe in release/
```

Layout:

- `src/shared/`: cut engine, audio sync, and types shared by both processes
- `electron/`: main process: ffmpeg probing and loudness analysis (cached), the export pipeline, and a `media://`
  protocol that streams local files to the preview with seeking
- `src/renderer/`: React UI (preview, timeline, side panels)

Exports render each shot frame-accurately, mix all the mics as one continuous track (optionally normalised to −16 LUFS),
then mux, so the sound never cuts or drifts at camera switches. Hardware encoders (NVIDIA/Intel/AMD) are offered when
the machine supports them.
