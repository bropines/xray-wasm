//go:build js && wasm

// Added to the standard library's syscall package for the js/wasm build only,
// through `go build -overlay` (scripts/build.ts) — neither GOROOT
// nor Xray-core's source is modified.
//
// Xray-core takes len(syscall.RawSockaddrUnix{}.Path) to pad abstract unix
// socket names ("@@name", HAProxy-style) in common/utils, infra/conf
// (vless/trojan fallbacks, transport_security) and transport/internet. The
// js port of syscall has no unix sockets and so no such type, and the core
// does not compile without it. Every one of those uses is behind
// `runtime.GOOS == "linux" || runtime.GOOS == "android"`, so under js the
// value is never read; the layout is Linux's (sys/un.h: 108 bytes) so that it
// would be right if it were.

package syscall

type RawSockaddrUnix struct {
	Family uint16
	Path   [108]int8
}
