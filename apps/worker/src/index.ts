import { getDeviceIdentity, WorkerRuntime, detectMediaTools } from './runtime.js';
const identity = getDeviceIdentity({ load: () => undefined, save: () => {} });
const runtime = new WorkerRuntime(identity, detectMediaTools());
console.log(JSON.stringify(runtime.hello(process.platform, process.arch)));
