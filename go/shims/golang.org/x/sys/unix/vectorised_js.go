//go:build js && wasm

// Added to golang.org/x/sys/unix for the js/wasm build only (see flock_js.go
// for how). Cores up to v26.9.9 import github.com/sagernet/sing for
// Shadowsocks 2022, and its common/bufio/vectorised_unix.go (built on every
// non-Windows GOOS) writes with writev/sendmsg through these names. That code
// runs when a connection writes — after Start(), which xray-wasm never
// reaches (it refuses `run` without -test). Layouts are Linux amd64's;
// every call fails with ENOSYS.

package unix

import "syscall"

type Errno = syscall.Errno

const (
	EAGAIN      = syscall.EAGAIN
	EWOULDBLOCK = syscall.EWOULDBLOCK
	SYS_WRITEV  = 20
)

type Iovec struct {
	Base *byte
	Len  uint64
}

func (iov *Iovec) SetLen(length int) { iov.Len = uint64(length) }

type Msghdr struct {
	Name       *byte
	Namelen    uint32
	Iov        *Iovec
	Iovlen     uint64
	Control    *byte
	Controllen uint64
	Flags      int32
}

func (msghdr *Msghdr) SetIovlen(length int) { msghdr.Iovlen = uint64(length) }

func Syscall(trap, a1, a2, a3 uintptr) (r1, r2 uintptr, err Errno) {
	return 0, 0, syscall.ENOSYS
}

// sing reaches this one through go:linkname.
func sendmsg(s int, msg *Msghdr, flags int) (n int, err error) {
	return 0, syscall.ENOSYS
}
