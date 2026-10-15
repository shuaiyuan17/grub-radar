/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional "lat,lng" for the home origin. See .env.example. */
  readonly VITE_HOME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
