// The only bridge between the interface and the trading process. Every call
// is a named channel; nothing else from Node or Electron reaches the page.
import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = [
  'terms:status', 'terms:accept',
  'state:get', 'board:get', 'engine:start', 'engine:stop', 'engine:cycle', 'engine:killSwitch',
  'auth:status', 'auth:emailStart', 'auth:emailVerify', 'auth:wallet', 'auth:signOut',
  'keys:describe', 'keys:set', 'keys:remove', 'keys:test',
  'ai:models', 'ai:configured',
  'settings:account', 'settings:saveAccount',
  'bots:list', 'bots:new', 'bots:save', 'bots:delete', 'bots:draft',
  'ledger:tickets', 'ledger:events',
  'accuracy:get', 'accuracy:run', 'clipboard:write'
] as const

type Channel = (typeof CHANNELS)[number]

async function call<T>(channel: Channel, ...args: unknown[]): Promise<T> {
  if (!CHANNELS.includes(channel)) throw new Error(`blocked channel ${channel}`)
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res.ok) throw new Error(res.error)
  return res.value as T
}

function on(event: 'state' | 'ticket', fn: (payload: any) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => fn(payload)
  ipcRenderer.on(event, listener)
  return () => ipcRenderer.removeListener(event, listener)
}

contextBridge.exposeInMainWorld('lazyedge', { call, on })
