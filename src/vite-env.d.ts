/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" to use a static mock puzzle when running `npm run dev` (no AppSync). */
  readonly VITE_MOCK_PUZZLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
