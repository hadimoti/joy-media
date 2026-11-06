import { answerHashRequest, type HashRequest } from './blob-sha256.js';

// Dedicated worker behind sha256OfBlob: hash the one Blob in each message and post back the reply.
globalThis.onmessage = (event: MessageEvent<HashRequest>) => {
  void answerHashRequest(event.data).then((reply) => {
    globalThis.postMessage(reply);
  });
};
