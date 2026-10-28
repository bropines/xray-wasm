//go:build js && wasm

// Added to golang.org/x/sys/unix for the js/wasm build only, through `go build
// -overlay` (scripts/build.ts) — the module cache and Xray-core's
// source are not modified.
//
// Xray-core's transport/internet/filelocker_other.go (built on every
// non-Windows GOOS) locks the lock file of a unix-socket listener with
// unix.Flock. x/sys/unix has no js port, so the core does not compile without
// these names. FileLocker runs only when a listener is opened, i.e. in
// Start(), which xray-wasm never reaches (it refuses `run` without -test);
// if it ever ran here it would fail with ENOSYS rather than pretend to lock.

package unix

import "syscall"

// Values from Linux's sys/file.h.
const (
	LOCK_SH = 0x1
	LOCK_EX = 0x2
	LOCK_NB = 0x4
	LOCK_UN = 0x8
)

func Flock(fd int, how int) error {
	return syscall.ENOSYS
}
