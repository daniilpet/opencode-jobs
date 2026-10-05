import { parentPort, workerData } from 'node:worker_threads';

try {
  const regex = new RegExp(workerData.pattern);
  parentPort.postMessage({ matches: workerData.lines.map((line) => regex.test(line)) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
