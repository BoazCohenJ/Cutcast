/// <reference types="vite/client" />

declare global {
  interface Window {
    desktopApi: {
      openMediaFiles: () => Promise<string[]>;
      chooseSaveFile: () => Promise<string | null>;
      exportProject: (payload: unknown) => Promise<string>;
      showHelp: () => Promise<void>;
    };
  }
}

export {};
