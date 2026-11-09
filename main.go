// hotaisle-ui: a local web app for renting Hot Aisle GPU compute.
//
//	hotaisle-ui            open the app in your browser, signed in with your Hot Aisle CLI login
//	hotaisle-ui --demo     try it with sample data, no account needed
//	hotaisle-ui --host :8080            host it for many people, each signing in with their own API key
//	hotaisle-ui --host :8080 --demo     host a public demo with sample data only
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"hotaisle-ui/internal/config"
	"hotaisle-ui/internal/server"
	"hotaisle-ui/web"
)

var version = "dev"

func main() {
	port := flag.Int("port", 0, "port on 127.0.0.1 (default: any free port)")
	noOpen := flag.Bool("no-open", false, "print the link instead of opening a browser")
	demo := flag.Bool("demo", false, "start with sample data instead of your account")
	cfgPath := flag.String("config-file", "", "Hot Aisle CLI config file (default ~/.hotaisle/config.json, or $HOTAISLE_CONFIG_FILE)")
	apiBase := flag.String("api", envOr("HOTAISLE_API_BASE", "https://admin.hotaisle.app/api"), "API base URL")
	showVersion := flag.Bool("version", false, "print the version")
	staticDir := flag.String("static", "", "serve the web app from this directory instead of the embedded copy (for development with `npm run watch`)")
	host := flag.String("host", os.Getenv("HOTAISLE_UI_HOST"), "host it for many people on this address (\":8080\"; \"auto\" = :$PORT or :8080). Each visitor signs in with their own API key")
	dataDir := flag.String("data", os.Getenv("HOTAISLE_UI_DATA"), "hosted: keep each account's machine records in this directory (never tokens; default: memory)")
	publicHost := flag.String("public-host", os.Getenv("HOTAISLE_UI_PUBLIC_HOST"), "hosted: the public host name to accept (default: any)")
	flag.Parse()
	if v := os.Getenv("HOTAISLE_UI_DEMO"); v == "1" || v == "true" {
		*demo = true
	}
	if *showVersion {
		fmt.Println("hotaisle-ui", version)
		return
	}

	if *host != "" {
		serveHosted(*host, *dataDir, *publicHost, *apiBase, *demo, *staticDir)
		return
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fatal(err)
	}
	static := web.Dist()
	if *staticDir != "" {
		static = os.DirFS(*staticDir)
	}
	statePath := filepath.Join(filepath.Dir(cfg.Path), "ui-state.json")
	secretPath := filepath.Join(filepath.Dir(cfg.Path), "ui-session")
	srv, err := server.New(server.Options{APIBase: *apiBase, Config: cfg, Static: static, StartDemo: *demo, Version: version, StatePath: statePath, SecretPath: secretPath})
	if err != nil {
		fatal(err)
	}
	ln, link, err := srv.Listen(*port)
	if err != nil {
		fatal(err)
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}

	switch {
	case *demo:
		fmt.Println("hotaisle-ui: demo mode, sample data only")
	case cfg.APIToken != "":
		fmt.Printf("hotaisle-ui: signed in with the token from %s\n", map[string]string{"env": "$HOTAISLE_API_TOKEN", "file": cfg.Path}[cfg.TokenSource])
	default:
		fmt.Println("hotaisle-ui: no Hot Aisle login found; the app will walk you through it")
	}
	fmt.Printf("hotaisle-ui: open %s\n", link)
	fmt.Println("hotaisle-ui: Ctrl-C to quit")
	if !*noOpen {
		openBrowser(link)
	}

	timers, stopTimers := context.WithCancel(context.Background())
	defer stopTimers()
	go srv.RunTimers(timers, 15*time.Second)
	go func() {
		if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = hs.Shutdown(ctx)
}

// serveHosted runs one server for many people. The host's own Hot Aisle login is never read.
func serveHosted(addr, dataDir, publicHost, apiBase string, demoOnly bool, staticDir string) {
	if addr == "auto" {
		addr = ":" + envOr("PORT", "8080")
	}
	if dataDir != "" {
		if err := os.MkdirAll(dataDir, 0o700); err != nil {
			fatal(err)
		}
	}
	static := web.Dist()
	if staticDir != "" {
		static = os.DirFS(staticDir)
	}
	srv, err := server.New(server.Options{APIBase: apiBase, Config: &config.Config{}, Static: static, Version: version,
		Hosted: true, DemoOnly: demoOnly, DataDir: dataDir, Host: publicHost})
	if err != nil {
		fatal(err)
	}
	ln, err := srv.ListenHosted(addr)
	if err != nil {
		fatal(err)
	}
	what := "each visitor signs in with their own Hot Aisle API key, kept in memory for their session only"
	if demoOnly {
		what = "a public demo: sample data only, API keys are refused"
	}
	fmt.Printf("hotaisle-ui %s: hosting on %s, %s\n", version, ln.Addr(), what)
	if dataDir != "" {
		fmt.Printf("hotaisle-ui: machine records in %s (no tokens)\n", dataDir)
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	timers, stopTimers := context.WithCancel(context.Background())
	defer stopTimers()
	go srv.RunTimers(timers, 15*time.Second)
	go func() {
		if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = hs.Shutdown(ctx)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func openBrowser(u string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	_ = cmd.Start()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "hotaisle-ui:", err)
	os.Exit(1)
}
