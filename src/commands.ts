/**
 * Which `xray` commands are run, and how a check is phrased as one.
 *
 * Everything the binary does offline runs as is. What would start a server
 * or reach the network is refused before the binary is started, with a
 * message saying so: in js/wasm Go has an in-process fake network (nothing
 * listens or dials for real, so a server would wait forever for traffic that
 * cannot come) and net/http goes through the page's fetch(), so these would
 * either hang until the timeout or make requests the caller did not expect.
 */

const HELP = new Set(['-h', '-help', '--help', 'help']);

/**
 * The command main.go would run: getArgsV4Compatible maps no arguments to
 * `run`, `-h` to `help`, `-version` to `version`, and other leading flags to
 * `run <flags>`.
 */
export function effectiveArgs(args: string[]): string[] {
    if (args.length === 0) return ['run'];
    if (!args[0]!.startsWith('-')) return args;
    if (args.some(arg => arg === '-h' || arg === '-help' || arg === '--help')) return ['help'];
    if (args.some(arg => /^--?version(?:=true)?$/.test(arg))) return ['version'];
    return ['run', ...args];
}

const flagValue = (arg: string) => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg);

/** Why this command is not run here, or null to run it. */
export function refusal(args: string[]): string | null {
    const [command, ...rest] = effectiveArgs(args);
    const asksHelp = rest.some(arg => HELP.has(arg));
    if (command === 'run') {
        if (asksHelp) return null;
        const flags = new Set(rest.map(arg => arg.replace(/^--?/, '').replace(/=true$/, '')));
        if (!flags.has('test') && !flags.has('dump')) {
            return 'xray-wasm: `run` without -test or -dump would start the server; in WebAssembly nothing can listen or dial. Use `run -test -c config.json` (or check()).';
        }
        if (rest.some(arg => /^(?:https?:\/\/)/i.test(flagValue(arg)))) {
            return 'xray-wasm: loading a config from a URL needs the network; pass the file in `files` instead.';
        }
        return null;
    }
    if (command === 'api' && rest.length > 0 && !asksHelp) {
        return `xray-wasm: \`api ${rest[0]}\` talks to a running Xray over gRPC; there is none to reach from WebAssembly.`;
    }
    if (command === 'tls' && rest[0] === 'ping' && !rest.slice(1).some(arg => HELP.has(arg))) {
        return 'xray-wasm: `tls ping` connects to a server; WebAssembly in a page cannot open a TCP connection.';
    }
    return null;
}

/** The file a check writes the config to, relative to the CLI's working directory. */
export const CHECK_CONFIG_NAME = 'config.json';

/**
 * `xray run -test -c config.json`, from the working directory: the core then
 * names the file "config.json" in its errors, as it does on a node run from
 * the config's folder.
 */
export const CHECK_ARGS = ['run', '-test', '-c', CHECK_CONFIG_NAME];
