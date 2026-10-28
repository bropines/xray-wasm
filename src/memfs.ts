/**
 * The file system and process a Go js/wasm program sees, served from memory.
 *
 * Go's `syscall` on js/wasm (GOROOT/src/syscall/fs_js.go) does every file
 * operation through a Node-shaped `globalThis.fs`, asks `globalThis.process`
 * for the working directory and `globalThis.path.resolve` for an open file's
 * name, all captured once when the runtime starts. In a
 * browser wasm_exec.js installs stubs that answer ENOSYS to everything, so the
 * core could not even tell "no such file" from "no file system"; under Node or
 * Bun they would be the host's real ones. This holds exactly the files the
 * caller hands over; every other path is ENOENT, and every path the program
 * looked for and did not find is recorded — that list is how a check tells
 * "the config is wrong" apart from "the config names a file it was not given".
 *
 * Read-only for a check (a write is EROFS, as it was in the wrapper the
 * verdicts were first measured with); writable for the CLI, whose `tls cert
 * -file` and `convert pb -o` write files the caller gets back.
 *
 * Shape of each call (name, argument order, callback, error `code`) follows
 * fs_js.go exactly: an error whose `code` Go does not know makes it panic.
 * fs_js.go passes relative paths through unchanged (Node would resolve them
 * against process.cwd()), so they are resolved here against `cwd`.
 */

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFCHR = 0o020000;

/** Any distinct values work: fs_js.go reads them back from `constants`. */
const CONSTANTS = {
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_TRUNC: 512,
    O_APPEND: 1024,
    O_DIRECTORY: 65536,
};
const WRITE_FLAGS = CONSTANTS.O_WRONLY | CONSTANTS.O_RDWR | CONSTANTS.O_CREAT | CONSTANTS.O_TRUNC | CONSTANTS.O_APPEND;

type Callback = (err: Error | null, value?: unknown) => void;

interface Entry { data: Uint8Array; mode: number; mtimeMs: number }

interface OpenFile {
    path: string;
    /** null: a directory. */
    entry: Entry | null;
    pos: number;
    append: boolean;
    writable: boolean;
}

export interface MemFsOptions {
    /** Absolute or relative (to `cwd`) path → contents. */
    files?: Record<string, Uint8Array>;
    writable?: boolean;
    /** Working directory, created if missing. Default `/`. */
    cwd?: string;
    stdin?: Uint8Array;
    /** Directories that exist even when empty (e.g. /tmp). */
    dirs?: string[];
    /** Cap on collected stdout + stderr, in bytes. */
    maxOutput?: number;
}

export interface MemFs {
    /** Install as `globalThis.fs`; must happen before the Go instance starts. */
    readonly fs: Record<string, unknown>;
    /** Install as `globalThis.process`, likewise. */
    readonly process: Record<string, unknown>;
    /** Install as `globalThis.path`, likewise. */
    readonly path: Record<string, unknown>;
    /** Absolute paths the program stat'ed or opened and did not find, in order, once each. */
    readonly missing: string[];
    /** Paths the program created or changed (or, read-only, tried to). */
    readonly writes: string[];
    /** stdout and stderr interleaved, split into lines. */
    output(): string[];
    stdout(): Uint8Array;
    stderr(): Uint8Array;
    /** Files that were created or changed and still exist, by absolute path. */
    changedFiles(): Record<string, Uint8Array>;
    cwd(): string;
}

const fsError = (code: string, path?: string): Error =>
    Object.assign(new Error(path ? `${code}: ${path}` : code), { code });

/** POSIX normalisation without node:path — this runs in a worker. */
export function normalizePath(path: string): string {
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') parts.pop();
        else parts.push(part);
    }
    return `/${parts.join('/')}`;
}

const parentOf = (path: string) => normalizePath(`${path}/..`);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

class Output {
    private chunks: Uint8Array[] = [];
    private size = 0;
    constructor(private readonly shared: { left: number }) {}
    write(buf: Uint8Array) {
        const take = Math.min(buf.length, this.shared.left);
        if (take > 0) {
            this.chunks.push(buf.slice(0, take));
            this.size += take;
            this.shared.left -= take;
        }
        return buf.length;
    }
    bytes(): Uint8Array {
        const out = new Uint8Array(this.size);
        let at = 0;
        for (const chunk of this.chunks) { out.set(chunk, at); at += chunk.length; }
        return out;
    }
}

export function createMemFs(opts: MemFsOptions = {}): MemFs {
    const writable = opts.writable ?? false;
    let cwd = normalizePath(opts.cwd ?? '/');
    const resolve = (path: string) => normalizePath(path.startsWith('/') ? path : `${cwd}/${path}`);

    const content = new Map<string, Entry>();
    const dirs = new Map<string, Set<string>>([['/', new Set()]]);
    const addDir = (path: string) => {
        let child = path;
        if (!dirs.has(child)) dirs.set(child, new Set());
        while (child !== '/') {
            const parent = parentOf(child);
            if (!dirs.has(parent)) dirs.set(parent, new Set());
            dirs.get(parent)!.add(baseName(child));
            child = parent;
        }
    };
    const addFile = (path: string, data: Uint8Array) => {
        content.set(path, { data, mode: 0o644, mtimeMs: 0 });
        addDir(parentOf(path));
        dirs.get(parentOf(path))!.add(baseName(path));
    };
    addDir(cwd);
    for (const dir of opts.dirs ?? []) addDir(resolve(dir));
    for (const [rawPath, data] of Object.entries(opts.files ?? {})) addFile(resolve(rawPath), data);

    const missing: string[] = [];
    const writes: string[] = [];
    const changed = new Set<string>();
    const fds = new Map<number, OpenFile>();
    let nextFd = 3;
    const stdin = opts.stdin ?? new Uint8Array(0);
    let stdinPos = 0;
    const budget = { left: opts.maxOutput ?? 4 * 1024 * 1024 };
    const out = new Output(budget);
    const err = new Output(budget);
    let text = '';
    const decoder = new TextDecoder();

    const noteMissing = (path: string) => { if (!missing.includes(path)) missing.push(path); };
    const noteWrite = (path: string) => { if (!writes.includes(path)) writes.push(path); };
    const lookup = (path: string): { entry: Entry | null } | null => {
        if (content.has(path)) return { entry: content.get(path)! };
        if (dirs.has(path)) return { entry: null };
        return null;
    };

    const stat = (entry: Entry | null, chr = false) => ({
        dev: 1,
        ino: 0,
        mode: chr ? S_IFCHR | 0o666 : entry === null ? S_IFDIR | 0o755 : S_IFREG | entry.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: entry?.data.length ?? 0,
        blksize: 4096,
        blocks: Math.ceil((entry?.data.length ?? 0) / 512),
        atimeMs: entry?.mtimeMs ?? 0,
        mtimeMs: entry?.mtimeMs ?? 0,
        ctimeMs: entry?.mtimeMs ?? 0,
        isDirectory: () => !chr && entry === null,
    });

    const writeStd = (fd: number, buf: Uint8Array): number => {
        if (text.length < (opts.maxOutput ?? 4 * 1024 * 1024)) text += decoder.decode(buf, { stream: true });
        return (fd === 1 ? out : err).write(buf);
    };

    const writeFile = (file: OpenFile, buf: Uint8Array, position: number | null | undefined): number => {
        const entry = file.entry!;
        const at = file.append ? entry.data.length : position ?? file.pos;
        const end = at + buf.length;
        if (end > entry.data.length) {
            const grown = new Uint8Array(Math.max(end, entry.data.length * 2 > end ? end : end));
            grown.set(entry.data);
            entry.data = grown;
        }
        entry.data.set(buf, at);
        entry.mtimeMs = Date.now();
        if (position === null || position === undefined) file.pos = end;
        changed.add(file.path);
        noteWrite(file.path);
        return buf.length;
    };

    const readOnly = (path?: string) => fsError('EROFS', path);
    const removeFromParent = (path: string) => dirs.get(parentOf(path))?.delete(baseName(path));

    const fs: Record<string, unknown> = {
        constants: CONSTANTS,
        writeSync(fd: number, buf: Uint8Array) {
            if (fd === 1 || fd === 2) return writeStd(fd, buf);
            const file = fds.get(fd);
            if (!file || !file.writable || !file.entry) throw fsError('EBADF');
            return writeFile(file, buf, null);
        },
        write(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: Callback) {
            const chunk = buf.subarray(offset, offset + length);
            if (fd === 1 || fd === 2) return cb(null, writeStd(fd, chunk));
            const file = fds.get(fd);
            if (!file) return cb(fsError('EBADF'));
            if (!file.writable || !file.entry) {
                noteWrite(file.path);
                return cb(writable ? fsError('EBADF') : readOnly(file.path));
            }
            cb(null, writeFile(file, chunk, position));
        },
        open(rawPath: string, flags: number, mode: number, cb: Callback) {
            const path = resolve(rawPath);
            const writing = (flags & WRITE_FLAGS) !== 0;
            if (writing && !writable) {
                noteWrite(path);
                return cb(readOnly(path));
            }
            let found = lookup(path);
            if (found && (flags & CONSTANTS.O_CREAT) && (flags & CONSTANTS.O_EXCL)) return cb(fsError('EEXIST', path));
            if (found && found.entry === null && writing) return cb(fsError('EISDIR', path));
            if (!found) {
                if (!(flags & CONSTANTS.O_CREAT)) {
                    noteMissing(path);
                    return cb(fsError('ENOENT', path));
                }
                if (!dirs.has(parentOf(path))) {
                    noteMissing(parentOf(path));
                    return cb(fsError('ENOENT', path));
                }
                addFile(path, new Uint8Array(0));
                content.get(path)!.mode = (mode || 0o644) & 0o777;
                content.get(path)!.mtimeMs = Date.now();
                changed.add(path);
                noteWrite(path);
                found = lookup(path)!;
            }
            if (found.entry && (flags & CONSTANTS.O_TRUNC)) {
                found.entry.data = new Uint8Array(0);
                changed.add(path);
                noteWrite(path);
            }
            const fd = nextFd++;
            fds.set(fd, { path, entry: found.entry, pos: 0, append: (flags & CONSTANTS.O_APPEND) !== 0, writable: writing });
            cb(null, fd);
        },
        close(fd: number, cb: Callback) {
            if (fd >= 0 && fd <= 2) return cb(null);
            if (!fds.delete(fd)) return cb(fsError('EBADF'));
            cb(null);
        },
        read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: Callback) {
            if (fd === 0) {
                const chunk = stdin.subarray(stdinPos, stdinPos + length);
                buffer.set(chunk, offset);
                stdinPos += chunk.length;
                return cb(null, chunk.length);
            }
            const file = fds.get(fd);
            if (!file) return cb(fsError('EBADF'));
            if (file.entry === null) return cb(fsError('EISDIR', file.path));
            const from = position ?? file.pos;
            // The entry's buffer may be larger than the file only while growing; size is data.length.
            const chunk = file.entry.data.subarray(from, from + length);
            buffer.set(chunk, offset);
            if (position === null || position === undefined) file.pos += chunk.length;
            cb(null, chunk.length);
        },
        fstat(fd: number, cb: Callback) {
            if (fd >= 0 && fd <= 2) return cb(null, stat(null, true));
            const file = fds.get(fd);
            if (!file) return cb(fsError('EBADF'));
            cb(null, stat(file.entry));
        },
        stat(rawPath: string, cb: Callback) {
            const path = resolve(rawPath);
            const found = lookup(path);
            if (!found) {
                noteMissing(path);
                return cb(fsError('ENOENT', path));
            }
            cb(null, stat(found.entry));
        },
        lstat(path: string, cb: Callback) {
            (fs.stat as (p: string, c: Callback) => void)(path, cb);
        },
        readdir(rawPath: string, cb: Callback) {
            const path = resolve(rawPath);
            const dir = dirs.get(path);
            if (!dir) {
                if (!content.has(path)) noteMissing(path);
                return cb(fsError(content.has(path) ? 'ENOTDIR' : 'ENOENT', path));
            }
            cb(null, [...dir].sort());
        },
        fsync(_fd: number, cb: Callback) { cb(null); },
        readlink(path: string, cb: Callback) { cb(fsError('EINVAL', path)); },
    };

    const mutators: Record<string, (path: string, args: unknown[]) => void> = {
        mkdir(path) {
            if (lookup(path)) throw fsError('EEXIST', path);
            if (!dirs.has(parentOf(path))) throw fsError('ENOENT', path);
            addDir(path);
        },
        rmdir(path) {
            const dir = dirs.get(path);
            if (!dir) throw fsError(content.has(path) ? 'ENOTDIR' : 'ENOENT', path);
            if (dir.size) throw fsError('ENOTEMPTY', path);
            if (path === '/' || path === cwd) throw fsError('EBUSY', path);
            dirs.delete(path);
            removeFromParent(path);
        },
        unlink(path) {
            if (dirs.has(path)) throw fsError('EISDIR', path);
            if (!content.delete(path)) throw fsError('ENOENT', path);
            changed.delete(path);
            removeFromParent(path);
        },
        rename(from, args) {
            const to = resolve(String(args[0]));
            const entry = content.get(from);
            if (!entry) throw fsError(dirs.has(from) ? 'EXDEV' : 'ENOENT', from);
            if (!dirs.has(parentOf(to))) throw fsError('ENOENT', to);
            content.delete(from);
            changed.delete(from);
            removeFromParent(from);
            addFile(to, entry.data);
            changed.add(to);
            noteWrite(to);
        },
        truncate(path, args) {
            const entry = content.get(path);
            if (!entry) throw fsError('ENOENT', path);
            entry.data = resize(entry.data, Number(args[0]));
            changed.add(path);
        },
        chmod(path, args) {
            const entry = lookup(path);
            if (!entry) throw fsError('ENOENT', path);
            if (entry.entry) entry.entry.mode = Number(args[0]) & 0o777;
        },
        chown(path) { if (!lookup(path)) throw fsError('ENOENT', path); },
        lchown(path) { if (!lookup(path)) throw fsError('ENOENT', path); },
        utimes(path) { if (!lookup(path)) throw fsError('ENOENT', path); },
        link() { throw fsError('EPERM'); },
        symlink() { throw fsError('EPERM'); },
    };
    for (const [name, apply] of Object.entries(mutators)) {
        fs[name] = (...args: unknown[]) => {
            const cb = args[args.length - 1] as Callback;
            const path = typeof args[0] === 'string' ? resolve(args[0]) : '';
            if (!writable) {
                if (path) noteWrite(path);
                return cb(readOnly(path || undefined));
            }
            try {
                apply(path, args.slice(1, -1));
                if (path && name !== 'rename') noteWrite(path);
                cb(null);
            } catch (error) {
                cb(error as Error);
            }
        };
    }
    for (const name of ['fchmod', 'fchown', 'ftruncate']) {
        fs[name] = (fd: number, value: unknown, ...rest: unknown[]) => {
            const cb = rest[rest.length - 1] as Callback ?? (value as Callback);
            const file = fds.get(fd);
            if (!file) return cb(fsError('EBADF'));
            if (!writable) return cb(readOnly(file.path));
            if (name === 'ftruncate' && file.entry) {
                file.entry.data = resize(file.entry.data, Number(value));
                changed.add(file.path);
                noteWrite(file.path);
            }
            cb(null);
        };
    }

    const enosys = () => fsError('ENOSYS');
    const process: Record<string, unknown> = {
        // Unknown ids, as wasm_exec.js's own stub says; never the host's.
        getuid: () => -1,
        getgid: () => -1,
        geteuid: () => -1,
        getegid: () => -1,
        getgroups: () => { throw enosys(); },
        pid: -1,
        ppid: -1,
        umask: () => 0o022,
        cwd: () => cwd,
        chdir(path: string) {
            const target = resolve(path);
            if (!dirs.has(target)) throw fsError(content.has(target) ? 'ENOTDIR' : 'ENOENT', target);
            cwd = target;
        },
    };

    const path = {
        resolve: (...segments: string[]) => segments.reduce((at, segment) => (segment.startsWith('/') ? normalizePath(segment) : normalizePath(`${at}/${segment}`)), cwd),
    };

    return {
        fs,
        process,
        path,
        missing,
        writes,
        output: () => text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.length > 0),
        stdout: () => out.bytes(),
        stderr: () => err.bytes(),
        changedFiles() {
            const result: Record<string, Uint8Array> = {};
            for (const path of changed) {
                const entry = content.get(path);
                if (entry) result[path] = entry.data.slice();
            }
            return result;
        },
        cwd: () => cwd,
    };
}

function resize(data: Uint8Array, length: number): Uint8Array {
    const next = new Uint8Array(Math.max(0, length));
    next.set(data.subarray(0, next.length));
    return next;
}
