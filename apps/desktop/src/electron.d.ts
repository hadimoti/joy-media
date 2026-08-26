declare module 'electron' {
  export const app: {
    readonly isPackaged: boolean;
    getPath(name: 'userData'): string;
    whenReady(): Promise<void>;
    on(event: 'window-all-closed' | 'activate', listener: () => void): void;
    quit(): void;
  };
  export const BrowserWindow: new (options: {
    width: number;
    height: number;
    webPreferences: { preload: string; contextIsolation: boolean; nodeIntegration: boolean };
  }) => {
    loadFile(path: string): Promise<void>;
    loadURL(url: string): Promise<void>;
    on(event: 'closed', listener: () => void): void;
    webContents: { send(channel: string, value: unknown): void };
  };
  export const ipcMain: {
    handle(channel: string, listener: (...args: unknown[]) => unknown): void;
  };
  export const contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (_event: unknown, value: unknown) => void): void;
  };
}
