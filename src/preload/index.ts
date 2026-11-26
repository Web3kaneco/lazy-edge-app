// The only bridge between the interface and the trading process. Every call
// is a named channel; nothing else from Node or Electron reaches the page.
import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = [
  'terms:status', 'terms:accept',
  'state:get', 'board:get', 'engine:start', 'engine:stop', 'engine:cycle', 'engine:killSwitch', 'engine:cashOut',
  'auth:status', 'auth:setKey', 'auth:removeKey',
  'keys:describe', 'keys:set', 'keys:remove', 'keys:test',
  'ai:models', 'ai:configured',
  'settings:account', 'settings:saveAccount',
  'bots:list', 'bots:new', 'bots:save', 'bots:delete', 'bots:draft', 'bots:paperTest', 'bots:paperStop', 'test:export', 'results:apply',
  'ledger:tickets', 'ledger:events',
  'accuracy:get', 'accuracy:run', 'clipboard:write',
  'play:check', 'report:context', 'report:email', 'report:save',
  'notices:get', 'notices:dismiss', 'notices:check', 'report:day',
  'desk:get', 'desk:ask', 'desk:ai', 'desk:apply', 'desk:dismiss',
  'starters:status', 'starters:use', 'starters:reset', 'starters:keep', 'starters:undo', 'starters:dismiss',
  'ai:save', 'ai:changes', 'ai:undo', 'ai:why', 'trial:start', 'trial:accept', 'trial:drop',
  'desk:recap', 'desk:chat', 'desk:patternBot', 'desk:patternFix', 'desk:patternTrial',
  'chat:apply', 'chat:trial', 'app:logError'
] as const

type Channel = (typeof CHANNELS)[number]

async function call<T>(channel: Channel, ...args: unknown[]): Promise<T> {
  if (!CHANNELS.includes(channel)) throw new Error(`blocked channel ${channel}`)
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res.ok) throw new Error(res.error)
  return res.value as T
}

function on(event: 'state' | 'ticket' | 'notices' | 'cashOut' | 'desk', fn: (payload: any) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => fn(payload)
  ipcRenderer.on(event, listener)
  return () => ipcRenderer.removeListener(event, listener)
}

contextBridge.exposeInMainWorld('lazyedge', { call, on })
