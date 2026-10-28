/**
 * The Web Worker: holds the compiled binaries it was handed and runs one
 * request at a time, each in a fresh Go instance (exec.ts). It fetches
 * nothing itself — the caller's side does, with the caller's fetch.
 *
 * A module worker, so wasm_exec.js (a classic script that assigns
 * `globalThis.Go`; `importScripts` does not exist in a module worker) arrives
 * as text and is evaluated here.
 */
import { evaluateWasmExec, execute } from './exec.js';
import type { WorkerReply, WorkerRequest } from './worker-protocol.js';

interface Scope {
    postMessage(message: WorkerReply): void;
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
const scope = self as unknown as Scope;
const modules = new Map<string, WebAssembly.Module>();

let queue: Promise<void> = Promise.resolve();

scope.addEventListener('message', event => {
    const message = event.data as WorkerRequest;
    queue = queue.then(async () => {
        try {
            if (message.type === 'init') {
                evaluateWasmExec(message.wasmExec);
                scope.postMessage({ id: message.id, done: true });
            } else if (message.type === 'load') {
                modules.set(message.tag, message.module);
                scope.postMessage({ id: message.id, done: true });
            } else {
                const module = modules.get(message.tag);
                if (!module) throw new Error(`${message.tag} is not loaded in this worker`);
                const result = await execute(module, message.request).done;
                scope.postMessage({ id: message.id, result });
            }
        } catch (error) {
            scope.postMessage({ id: message.id, failure: error instanceof Error ? error.message : String(error) });
        }
    });
});
