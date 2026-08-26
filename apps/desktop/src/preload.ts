import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('joyWorker', {
  status: () => ipcRenderer.invoke('worker:status'),
  start: () => ipcRenderer.invoke('worker:start'),
  stop: () => ipcRenderer.invoke('worker:stop'),
  restart: () => ipcRenderer.invoke('worker:restart'),
  config: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  subscribe: (listener: (status: unknown) => void) => {
    ipcRenderer.on('worker:status-changed', (_event, status) => listener(status));
  },
});
