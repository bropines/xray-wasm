import { describe, expect, test } from 'bun:test';
import { createMemFs, normalizePath } from '../src/memfs';

type Err = (Error & { code?: string }) | null;
const call = (fs: Record<string, unknown>, name: string, ...args: unknown[]) =>
    new Promise<{ err: Err; value: any }>(resolve => {
        (fs[name] as (...a: unknown[]) => void)(...args, (err: Err, value?: any) => resolve({ err, value }));
    });

const O = { RDONLY: 0, WRONLY: 1, CREAT: 64, EXCL: 128, TRUNC: 512, APPEND: 1024 };
const enc = new TextEncoder();
const dec = new TextDecoder();

describe('memfs, read-only (check)', () => {
    const bytes = enc.encode('hello world');

    test('normalizes paths', () => {
        expect(normalizePath('/a//b/./c/../d')).toBe('/a/b/d');
        expect(normalizePath('relative/x')).toBe('/relative/x');
        expect(normalizePath('/..')).toBe('/');
    });

    test('opens, reads in order and at a position, stats, closes', async () => {
        const { fs } = createMemFs({ files: { '/usr/share/xray/geoip.dat': bytes } });
        const opened = await call(fs, 'open', '/usr/share/xray/geoip.dat', O.RDONLY, 0);
        expect(opened.err).toBeNull();
        const fd = opened.value as number;
        const buf = new Uint8Array(5);
        expect((await call(fs, 'read', fd, buf, 0, 5, null)).value).toBe(5);
        expect(dec.decode(buf)).toBe('hello');
        expect((await call(fs, 'read', fd, buf, 0, 5, null)).value).toBe(5);
        expect(dec.decode(buf)).toBe(' worl');
        // Positional reads do not move the cursor.
        expect((await call(fs, 'read', fd, buf, 0, 5, 0)).value).toBe(5);
        expect((await call(fs, 'read', fd, buf, 0, 5, null)).value).toBe(1);
        const st = (await call(fs, 'fstat', fd)).value;
        expect(st.size).toBe(bytes.length);
        expect(st.isDirectory()).toBe(false);
        expect(st.mode & 0o170000).toBe(0o100000);
        expect((await call(fs, 'close', fd)).err).toBeNull();
        expect((await call(fs, 'close', fd)).err?.code).toBe('EBADF');
    });

    test('directories exist for every parent and list their children', async () => {
        const { fs } = createMemFs({ files: { '/usr/share/xray/geoip.dat': bytes, '/usr/share/xray/geosite.dat': bytes } });
        expect((await call(fs, 'stat', '/usr/share/xray')).value.isDirectory()).toBe(true);
        expect((await call(fs, 'readdir', '/usr/share/xray')).value).toEqual(['geoip.dat', 'geosite.dat']);
        expect((await call(fs, 'readdir', '/usr/share')).value).toEqual(['xray']);
    });

    test('a missing path is ENOENT and is recorded once', async () => {
        const memfs = createMemFs();
        expect((await call(memfs.fs, 'stat', '/etc/ssl/cert.pem')).err?.code).toBe('ENOENT');
        expect((await call(memfs.fs, 'open', '/etc/ssl/cert.pem', O.RDONLY, 0)).err?.code).toBe('ENOENT');
        expect(memfs.missing).toEqual(['/etc/ssl/cert.pem']);
    });

    test('refuses writes, and says what was written to', async () => {
        const memfs = createMemFs({ files: { '/a': bytes } });
        expect((await call(memfs.fs, 'open', '/tmp/x', O.CREAT | O.WRONLY, 0o644)).err?.code).toBe('EROFS');
        expect((await call(memfs.fs, 'mkdir', '/tmp/dir', 0o755)).err?.code).toBe('EROFS');
        expect(memfs.writes).toEqual(['/tmp/x', '/tmp/dir']);
        expect(memfs.changedFiles()).toEqual({});
    });

    test('collects stdout and stderr, apart and interleaved', async () => {
        const memfs = createMemFs();
        (memfs.fs.writeSync as (fd: number, b: Uint8Array) => number)(1, enc.encode('first\nsec'));
        await call(memfs.fs, 'write', 2, enc.encode('ond\n'), 0, 4, null);
        expect(memfs.output()).toEqual(['first', 'second']);
        expect(dec.decode(memfs.stdout())).toBe('first\nsec');
        expect(dec.decode(memfs.stderr())).toBe('ond\n');
    });

    test('every error carries a code Go knows (an unknown one makes the runtime panic)', async () => {
        const memfs = createMemFs();
        const known = new Set(['ENOENT', 'EBADF', 'EROFS', 'EISDIR', 'ENOTDIR', 'EINVAL']);
        for (const name of ['chmod', 'rename', 'unlink', 'symlink', 'truncate', 'utimes']) {
            const { err } = await call(memfs.fs, name, '/x', 0);
            expect(known.has(err!.code!)).toBe(true);
        }
    });
});

describe('memfs, writable (CLI)', () => {
    test('relative paths resolve against cwd, which chdir moves', async () => {
        const memfs = createMemFs({ writable: true, cwd: '/work', files: { 'config.json': enc.encode('{}') } });
        expect((await call(memfs.fs, 'stat', 'config.json')).err).toBeNull();
        expect((memfs.process.cwd as () => string)()).toBe('/work');
        expect((memfs.path.resolve as (...s: string[]) => string)('config.json')).toBe('/work/config.json');
        expect(() => (memfs.process.chdir as (p: string) => void)('/nope')).toThrow();
        (memfs.process.chdir as (p: string) => void)('/');
        expect((await call(memfs.fs, 'stat', 'work/config.json')).err).toBeNull();
    });

    test('creates, writes, appends and truncates; returns what changed', async () => {
        const memfs = createMemFs({ writable: true, cwd: '/work', files: { 'kept.txt': enc.encode('same') } });
        const fd = (await call(memfs.fs, 'open', 'out.txt', O.CREAT | O.WRONLY | O.TRUNC, 0o600)).value as number;
        await call(memfs.fs, 'write', fd, enc.encode('abc'), 0, 3, null);
        await call(memfs.fs, 'write', fd, enc.encode('XYZ'), 0, 1, 1);
        await call(memfs.fs, 'close', fd);
        const fd2 = (await call(memfs.fs, 'open', 'out.txt', O.WRONLY | O.APPEND, 0)).value as number;
        await call(memfs.fs, 'write', fd2, enc.encode('!'), 0, 1, null);
        expect(Object.keys(memfs.changedFiles())).toEqual(['/work/out.txt']);
        expect(dec.decode(memfs.changedFiles()['/work/out.txt'])).toBe('aXc!');
        expect((await call(memfs.fs, 'open', 'out.txt', O.CREAT | O.EXCL | O.WRONLY, 0)).err?.code).toBe('EEXIST');
        expect((await call(memfs.fs, 'open', '/no/dir/file', O.CREAT | O.WRONLY, 0)).err?.code).toBe('ENOENT');
    });

    test('mkdir, rename, unlink, rmdir', async () => {
        const memfs = createMemFs({ writable: true, cwd: '/work' });
        expect((await call(memfs.fs, 'mkdir', 'd', 0o755)).err).toBeNull();
        expect((await call(memfs.fs, 'mkdir', 'd', 0o755)).err?.code).toBe('EEXIST');
        const fd = (await call(memfs.fs, 'open', 'd/a', O.CREAT | O.WRONLY, 0o644)).value as number;
        await call(memfs.fs, 'write', fd, enc.encode('x'), 0, 1, null);
        expect((await call(memfs.fs, 'rmdir', 'd')).err?.code).toBe('ENOTEMPTY');
        expect((await call(memfs.fs, 'rename', 'd/a', 'b')).err).toBeNull();
        expect(Object.keys(memfs.changedFiles())).toEqual(['/work/b']);
        expect((await call(memfs.fs, 'rmdir', 'd')).err).toBeNull();
        expect((await call(memfs.fs, 'unlink', 'b')).err).toBeNull();
        expect(memfs.changedFiles()).toEqual({});
    });

    test('stdin is fd 0', async () => {
        const memfs = createMemFs({ stdin: enc.encode('in') });
        const buf = new Uint8Array(8);
        expect((await call(memfs.fs, 'read', 0, buf, 0, 8, null)).value).toBe(2);
        expect((await call(memfs.fs, 'read', 0, buf, 0, 8, null)).value).toBe(0);
    });
});
