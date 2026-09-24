export const createId = () => Math.random().toString(36).slice(2, 10);

export const CAMERA_COLORS = ['#a3e635', '#38bdf8', '#a78bfa', '#f472b6', '#2dd4bf', '#facc15', '#fb7185'];

export const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;

export const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '');

/** 1:02:03.4 / 2:03.4 */
export function formatTime(seconds: number, precise = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const secText = precise ? secs.toFixed(1).padStart(4, '0') : String(Math.floor(secs)).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secText}` : `${minutes}:${secText}`;
}

export const formatDuration = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.max(1, minutes)} min`;
};

/** URL served by the main process's `media://` protocol (supports seeking). */
export const mediaUrl = (filePath: string) => `media://file/${encodeURIComponent(filePath)}`;

export const dbToGain = (db: number) => Math.pow(10, db / 20);
