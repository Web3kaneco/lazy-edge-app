/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  readonly MAIN_VITE_API_BASE?: string
  readonly MAIN_VITE_SUPABASE_URL?: string
  readonly MAIN_VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
