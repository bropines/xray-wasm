/** Messages between executor.ts and worker.ts. */
import type { ExecRequest, ExecResult } from './exec.js';

export type WorkerRequest =
    | { type: 'init'; id: number; wasmExec: string }
    | { type: 'load'; id: number; tag: string; module: WebAssembly.Module }
    | { type: 'exec'; id: number; tag: string; request: ExecRequest };

export type WorkerReply =
    | { id: number; done: true }
    | { id: number; result: ExecResult }
    | { id: number; failure: string };
