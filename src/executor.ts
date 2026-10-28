/**
 * Where a binary runs: in a Web Worker (default — a check must not block the
 * page, and a command that never exits is ended by terminating the worker),
 * or on the calling thread (no Worker: Node, tests, or `worker: false`).
 * Callers serialise requests; an executor runs one at a time.
 */
import { evaluateWasmExec, execute, type ExecRequest, type ExecResult } from './exec.js';
import type { WorkerReply, WorkerRequest } from './worker-protocol.js';

export interface Loaded {
    module: WebAssembly.Module;
}

export interface Executor {
    exec(tag: string, loaded: Loaded, wasmExec: string, request: ExecRequest, timeoutMs: number): Promise<ExecResult | 'timeout'>;
    dispose(): void;
}

export class InlineExecutor implements Executor {
    async exec(_tag: string, loaded: Loaded, wasmExec: string, request: ExecRequest, timeoutMs: number): Promise<ExecResult | 'timeout'> {
        evaluateWasmExec(wasmExec);
        const handle = execute(loaded.module, request);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
        const outcome = await Promise.race([handle.done, timeout]);
        clearTimeout(timer);
        // Nothing can stop a Go instance on this thread; this stops waking it
        // and gives the globals back, and the instance is left to be collected.
        if (outcome === 'timeout') handle.abort();
        return outcome;
    }

    dispose(): void {}
}

export class WorkerExecutor implements Executor {
    private worker: Worker | null = null;
    /** Tags the current worker holds; a new worker starts empty. */
    private loadedTags = new Set<string>();
    private wasmExecSent: string | null = null;
    private nextId = 1;
    private pending = new Map<number, (reply: WorkerReply) => void>();

    constructor(private readonly url: string | URL | undefined) {}

    private spawn(): Worker {
        if (this.worker) return this.worker;
        // Written out in full so bundlers (Vite, webpack 5, esbuild with a
        // plugin) see `new Worker(new URL(…, import.meta.url))` and ship the file.
        const worker = this.url
            ? new Worker(this.url, { type: 'module' })
            : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('message', event => {
            const reply = event.data as WorkerReply;
            this.pending.get(reply.id)?.(reply);
            this.pending.delete(reply.id);
        });
        worker.addEventListener('error', event => {
            const message = (event as ErrorEvent).message || 'the xray-wasm worker failed';
            for (const [id, resolve] of this.pending) resolve({ id, failure: message });
            this.pending.clear();
            if (this.worker === worker) this.reset();
        });
        this.worker = worker;
        return worker;
    }

    private reset() {
        this.worker?.terminate();
        this.worker = null;
        this.loadedTags.clear();
        this.wasmExecSent = null;
    }

    private send(message: WorkerRequest, timeoutMs?: number): Promise<WorkerReply | 'timeout'> {
        const worker = this.spawn();
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            this.pending.set(message.id, reply => { clearTimeout(timer); resolve(reply); });
            if (timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    this.pending.delete(message.id);
                    if (this.worker === worker) this.reset();
                    resolve('timeout');
                }, timeoutMs);
            }
            worker.postMessage(message);
        });
    }

    private async ensure(tag: string, loaded: Loaded, wasmExec: string): Promise<void> {
        if (this.wasmExecSent !== wasmExec) {
            const reply = await this.send({ type: 'init', id: this.nextId++, wasmExec });
            if (reply !== 'timeout' && 'failure' in reply) throw new Error(reply.failure);
            this.wasmExecSent = wasmExec;
        }
        if (this.loadedTags.has(tag)) return;
        // A compiled Module is cloned into the worker, not recompiled there.
        const reply = await this.send({ type: 'load', id: this.nextId++, tag, module: loaded.module });
        if (reply !== 'timeout' && 'failure' in reply) throw new Error(reply.failure);
        this.loadedTags.add(tag);
    }

    async exec(tag: string, loaded: Loaded, wasmExec: string, request: ExecRequest, timeoutMs: number): Promise<ExecResult | 'timeout'> {
        await this.ensure(tag, loaded, wasmExec);
        const reply = await this.send({ type: 'exec', id: this.nextId++, tag, request }, timeoutMs);
        if (reply === 'timeout') return 'timeout';
        if ('failure' in reply) throw new Error(reply.failure);
        if (!('result' in reply)) throw new Error('unexpected answer from the xray-wasm worker');
        return reply.result;
    }

    dispose(): void {
        for (const [id, resolve] of this.pending) resolve({ id, failure: 'disposed' });
        this.pending.clear();
        this.reset();
    }
}
