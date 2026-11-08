export {}

declare global {
  // package.json version, set at build time by electron.vite.config.ts.
  const __APP_VERSION__: string
  interface Window {
    lazyedge: {
      call<T = any>(channel: string, ...args: unknown[]): Promise<T>
      on(event: 'state' | 'ticket', fn: (payload: any) => void): () => void
    }
  }
}
