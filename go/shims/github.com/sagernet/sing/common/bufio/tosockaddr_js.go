//go:build js && wasm

// Added to github.com/sagernet/sing/common/bufio for the js/wasm build only
// (a copy of the module under the build directory; see
// scripts/build.ts). sing (Shadowsocks 2022 in cores up to
// v26.9.9) defines ToSockaddr per OS; vectorised_unix.go, which every
// non-Windows GOOS builds, calls it before sendmsg. On js there is no socket
// to address, and the sendmsg it feeds fails with ENOSYS (the x/sys/unix
// shim), so this only has to exist. It runs when a packet is written, after
// Start(), which xray-wasm never reaches (it refuses `run` without -test).

package bufio

import (
	"net/netip"
	"unsafe"
)

func ToSockaddr(destination netip.AddrPort) (name unsafe.Pointer, nameLen uint32) {
	return nil, 0
}
