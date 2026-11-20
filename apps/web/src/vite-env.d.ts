/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "browser" builds the app to run its services inside the browser (see lib/run-mode.ts). */
  readonly VITE_RUNTIME?: 'server' | 'browser';
}
