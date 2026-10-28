//go:build js && wasm

// Command xray-check is a wrapper around Xray-core's config loading — not
// what xray-wasm ships. It exists to compare against the tag's own `main`
// package (`xray run -test`), which is what is shipped: scripts/compare.ts
// runs every smoke config through both and reports any difference (README,
// "One binary per release"). Build it with `bun scripts/build.ts --variant check`.
//
// It is built per tag against that tag's own source (a `replace` the build
// script adds to a scratch copy of this module) and that tag's own import list
// (imports_gen.go, generated from the tag's main/distro/all/all.go minus the
// CLI-only packages). Nothing here patches the core.
//
// What `-test` does, in every built tag (main/run.go, startXray and
// executeRun): read the file, decode it with serial.DecodeJSONConfig, run
// conf.Config.Build() (every protocol's and transport's own Build), then
// core.New() — which constructs every feature without starting any of them —
// and exit before server.Start(). This does exactly that, on one in-memory
// "file", and never calls Start: nothing listens, nothing dials.
//
// The JS side gets two globals:
//
//	xrayCheck(configJson: string) => Promise<{ok, error?, version}>
//	xrayCheckExit() => void   // lets main return, so the instance can be dropped
//
// A check runs in a fresh Go instance (scripts/compare.ts, src/runner.ts):
// core.New mutates process-wide state (the `env` root object calls
// os.Setenv, geodata caches matchers, and a panic on a goroutine other than
// ours kills the whole runtime), so reusing an instance would let one
// config's check depend on the previous one.
package main

import (
	"fmt"
	"runtime/debug"
	"strings"
	"syscall/js"

	"github.com/xtls/xray-core/common/errors"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/infra/conf/serial"
)

// configName is what the CLI would print as the file it read; the error text
// then reads the way `xray run -test -c config.json` prints it.
const configName = "config.json"

type result struct {
	ok  bool
	err string
}

func check(configJSON string) (res result) {
	defer func() {
		if r := recover(); r != nil {
			res = result{err: fmt.Sprintf("panic: %v\n%s", r, debug.Stack())}
		}
	}()

	// main/run.go startXray: core.LoadConfig(format, files) -> for one JSON
	// file, serial.BuildConfig -> mergeConfigs (DecodeJSONConfig) -> Build().
	decoded, err := serial.DecodeJSONConfig(strings.NewReader(configJSON))
	if err != nil {
		err = errors.New("failed to decode config: ", configName).Base(err)
		return result{err: errors.New("failed to load config files: [", configName, "]").Base(err).Error()}
	}
	built, err := decoded.Build()
	if err != nil {
		return result{err: errors.New("failed to load config files: [", configName, "]").Base(err).Error()}
	}

	server, err := core.New(built)
	if err != nil {
		return result{err: errors.New("failed to create server").Base(err).Error()}
	}
	// executeRun exits here under -test. Close releases what New built
	// (it never started), so a reused instance would not keep it around.
	_ = server.Close()
	return result{ok: true}
}

func main() {
	done := make(chan struct{})
	promise := js.Global().Get("Promise")
	object := js.Global().Get("Object")

	checkFn := js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return promise.Call("reject", js.Global().Get("TypeError").New("xrayCheck(configJson: string)"))
		}
		configJSON := args[0].String()
		// A FuncOf handler runs on the event loop: anything that blocks inside
		// it (a timer, a channel the core waits on) deadlocks the runtime. So
		// the work runs on its own goroutine and settles a promise.
		var handler js.Func
		handler = js.FuncOf(func(this js.Value, pargs []js.Value) any {
			resolve := pargs[0]
			go func() {
				defer handler.Release()
				res := check(configJSON)
				out := object.New()
				out.Set("ok", res.ok)
				out.Set("version", core.Version())
				if !res.ok {
					out.Set("error", res.err)
				}
				resolve.Invoke(out)
			}()
			return nil
		})
		return promise.New(handler)
	})
	exitFn := js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case <-done:
		default:
			close(done)
		}
		return nil
	})

	js.Global().Set("xrayCheck", checkFn)
	js.Global().Set("xrayCheckExit", exitFn)
	js.Global().Set("xrayCheckVersion", core.Version())
	if ready := js.Global().Get("__xrayCheckReady"); ready.Type() == js.TypeFunction {
		ready.Invoke(core.Version())
	}

	<-done
	js.Global().Delete("xrayCheck")
	js.Global().Delete("xrayCheckExit")
	checkFn.Release()
	exitFn.Release()
}
