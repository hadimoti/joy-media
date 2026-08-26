import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, saveConfig, type DesktopConfig } from './config.js';
import { WorkerController } from './lifecycle.js';

let window: InstanceType<typeof BrowserWindow> | undefined;
let controller: WorkerController;
let configuration: DesktopConfig;

async function createWindow(): Promise<void> {
  const userData = app.getPath('userData');
  const settingsPath = configPath(userData);
  configuration = loadConfig(settingsPath);
  controller = new WorkerController({
    config: configuration,
    userDataPath: userData,
    packaged: app.isPackaged,
  });
  window = new BrowserWindow({
    width: 760,
    height: 620,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.js', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controller.onStatus((status) => window?.webContents.send('worker:status-changed', status));
  registerIpc(settingsPath, userData);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderHtml())}`);
  window.on('closed', () => {
    window = undefined;
  });
}

function registerIpc(settingsPath: string, userData: string): void {
  ipcMain.handle('worker:status', () => controller.status());
  ipcMain.handle('worker:start', () => controller.start());
  ipcMain.handle('worker:stop', () => controller.stop());
  ipcMain.handle('worker:restart', () => controller.restart());
  ipcMain.handle('config:get', () => configuration);
  ipcMain.handle('config:save', async (_event: unknown, candidate: unknown) => {
    const next = parseConfig(candidate);
    saveConfig(settingsPath, next);
    configuration = next;
    await controller.stop();
    controller = new WorkerController({
      config: configuration,
      userDataPath: userData,
      packaged: app.isPackaged,
    });
    controller.onStatus((status) => window?.webContents.send('worker:status-changed', status));
    return configuration;
  });
}

function parseConfig(value: unknown): DesktopConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid configuration');
  const raw = value as Record<string, unknown>;
  const result: DesktopConfig = { apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl : '' };
  for (const key of ['workerStatePath', 'ffmpegPath', 'ffprobePath', 'localAssetsJson'] as const) {
    if (raw[key] !== undefined && typeof raw[key] === 'string')
      (result as unknown as Record<string, string>)[key] = raw[key];
  }
  return result;
}

function renderHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>JOY Media Worker</title><style>body{font:14px system-ui;margin:24px;color:#202124;background:#f7f8fa}main{max-width:680px;margin:auto;background:white;padding:24px;border-radius:12px;box-shadow:0 2px 10px #0001}button{margin-right:8px;padding:9px 14px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer}button:hover{background:#eef3ff}code,pre{background:#f1f3f4;border-radius:6px;padding:8px}pre{height:220px;overflow:auto;white-space:pre-wrap}.row{margin:12px 0}label{display:block;font-weight:600;margin-bottom:4px}input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb;border-radius:5px}</style></head><body><main><h1>JOY Media Worker</h1><div class="row">Status: <strong id="state">loading</strong></div><div class="row">Worker ID: <code id="worker">—</code></div><div class="row">Pairing code: <code id="pairing">—</code></div><div class="row">Media tools: <span id="tools">—</span></div><div class="row"><button id="start">Start</button><button id="stop">Stop</button><button id="restart">Restart</button></div><details><summary>Local configuration</summary><p>Only non-secret connection and local tool paths are stored.</p><label>API URL<input id="apiUrl" autocomplete="off"></label><label>FFmpeg path<input id="ffmpegPath" autocomplete="off"></label><label>ffprobe path<input id="ffprobePath" autocomplete="off"></label><button id="save">Save configuration</button></details><h2>Recent redacted logs</h2><pre id="logs">—</pre></main><script>const api=window.joyWorker;const $=id=>document.getElementById(id);function show(s){$('state').textContent=s.state;$('worker').textContent=s.workerId||'—';$('pairing').textContent=s.pairingCode||'—';$('tools').textContent=s.mediaTools.ready?'ready':(s.mediaTools.reason||'unavailable');$('logs').textContent=(s.logs||[]).join('\\n')||'—'}async function call(name){show(await api[name]())}for(const n of ['start','stop','restart'])$(n).onclick=()=>call(n);$('save').onclick=async()=>{await api.saveConfig({apiUrl:$('apiUrl').value,ffmpegPath:$('ffmpegPath').value||undefined,ffprobePath:$('ffprobePath').value||undefined});show(await api.status())};api.config().then(c=>{for(const k of ['apiUrl','ffmpegPath','ffprobePath'])$(k).value=c[k]||''});api.status().then(show);api.subscribe(show);</script></body></html>`;
}

app
  .whenReady()
  .then(createWindow)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'desktop startup failed');
    app.quit();
  });
app.on('window-all-closed', () => app.quit());
