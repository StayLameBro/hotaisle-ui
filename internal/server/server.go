// Package server serves the UI on localhost and forwards its API calls to Hot Aisle.
//
// Why a local server: the Hot Aisle API does not answer browser CORS requests, and an API token
// should not live in a web page. The browser talks only to this process; this process adds the
// token and forwards to https://admin.hotaisle.app/api. The token never reaches the browser.
//
// Local safety: it listens on 127.0.0.1 only, rejects any Host header but its own (DNS rebinding),
// requires a per-launch secret cookie set by the link it opens (other sites and other local users
// can't drive it), and requires a custom header on every API call (cross-site forms can't send one).
//
// Hosted (Options.Hosted): one server for many people. Each visitor gets a session of their own: the API
// token they paste is kept in this process's memory for that session only, never written to disk and
// never sent to the page; sample data is a sandbox per session; the host's own CLI login and ~/.ssh are
// never read. See hosted.go.
package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"hotaisle-ui/internal/config"
	"hotaisle-ui/internal/demo"
	"hotaisle-ui/internal/state"
)

const cookieName = "hotaisle_ui"

type ctxKey struct{}

// account is whose API calls these are: the one person at this computer (local), or one visitor's
// session (hosted). Each has its own token, its own sample-data sandbox and its own machine records.
type account struct {
	mu     sync.Mutex
	token  string
	team   string // hosted: the session's default team
	inDemo bool
	demo   *demo.API
	sample *state.Store // sample machines, never written to disk
	real   *state.Store // the account's machines
	user   *hostedUser  // hosted: the signed-in account, shared by its sessions
	seen   time.Time
}

func (a *account) snapshot() (token string, inDemo bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.token, a.inDemo
}

func (a *account) store() *state.Store {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.inDemo {
		return a.sample
	}
	return a.real
}

func acctOf(r *http.Request) *account { return r.Context().Value(ctxKey{}).(*account) }

// Options configure a Server.
type Options struct {
	APIBase   string // e.g. https://admin.hotaisle.app/api
	Config    *config.Config
	Static    fs.FS // the built web app
	StartDemo bool
	Version   string
	StatePath string // where launch times and release timers are kept ("" = memory only)

	// Hosted serves many people from one server; see hosted.go.
	Hosted   bool
	DemoOnly bool   // hosted: sample data only; real API tokens are refused (a public demo site)
	DataDir  string // hosted: where each account's machine records are kept ("" = memory only). Never tokens.
	Host     string // hosted: the public host name, checked against the Host header ("" = any)
}

type Server struct {
	opt    Options
	secret string
	addr   string // host:port the browser uses
	proxy  *httputil.ReverseProxy
	demo   *demo.API
	client *http.Client
	real   *state.Store // local: the account's machines
	sample *state.Store // local: demo machines, never written to disk
	local  *account     // local: the one account

	hosted *hosted // hosted: sessions and accounts
}

func New(opt Options) (*Server, error) {
	base, err := url.Parse(strings.TrimRight(opt.APIBase, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("invalid API base %q", opt.APIBase)
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	real, err := state.Open(opt.StatePath)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", opt.StatePath, err)
	}
	sample, _ := state.Open("")
	s := &Server{opt: opt, secret: hex.EncodeToString(b), demo: demo.New(),
		client: &http.Client{Timeout: 30 * time.Second}, real: real, sample: sample}
	if opt.Hosted {
		s.hosted = newHosted(opt)
	} else {
		s.local = &account{token: opt.Config.APIToken, inDemo: opt.StartDemo, demo: s.demo, sample: sample, real: real}
	}
	s.proxy = &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			// /api/teams/x/ -> <base>/teams/x/  (base already ends in /api)
			pr.Out.URL.Scheme = base.Scheme
			pr.Out.URL.Host = base.Host
			pr.Out.URL.Path = base.Path + strings.TrimPrefix(pr.In.URL.Path, "/api")
			pr.Out.URL.RawPath = ""
			if pr.In.URL.RawPath != "" {
				pr.Out.URL.RawPath = base.Path + strings.TrimPrefix(pr.In.URL.RawPath, "/api")
			}
			pr.Out.Host = base.Host
			for _, h := range []string{"Cookie", "Origin", "Referer", "X-Requested-With", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"} {
				pr.Out.Header.Del(h)
			}
			tok, _ := acctOf(pr.In).snapshot()
			pr.Out.Header.Set("Authorization", "Token "+tok)
			pr.Out.Header.Set("User-Agent", "hotaisle-ui/"+opt.Version)
		},
		ModifyResponse: func(r *http.Response) error {
			r.Header.Del("Set-Cookie")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "could not reach the Hot Aisle API: "+err.Error(), http.StatusBadGateway)
		},
	}
	return s, nil
}

// ListenHosted binds addr (":8080", "0.0.0.0:8080") for a hosted server and returns the address.
func (s *Server) ListenHosted(addr string) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s.addr = ln.Addr().String()
	return ln, nil
}

// Listen binds 127.0.0.1:port (0 picks a free port) and returns the URL to open.
func (s *Server) Listen(port int) (net.Listener, string, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, "", err
	}
	s.addr = ln.Addr().String()
	return ln, fmt.Sprintf("http://%s/open?k=%s", s.addr, s.secret), nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/open", s.handleOpen)
	mux.Handle("/api/", s.guard(http.HandlerFunc(s.handleAPI)))
	mux.Handle("/local/", s.guard(http.HandlerFunc(s.handleLocal)))
	mux.Handle("/", s.static())
	return s.hostCheck(securityHeaders(mux))
}

func (s *Server) hostCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.hosted != nil {
			// a public server: DNS rebinding has nothing to reach, but a host name, if given, is held to
			if s.opt.Host != "" && !strings.EqualFold(r.Host, s.opt.Host) {
				http.Error(w, "unexpected Host header", http.StatusMisdirectedRequest)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		_, port, _ := net.SplitHostPort(s.addr)
		if r.Host != s.addr && r.Host != "localhost:"+port {
			http.Error(w, "unexpected Host header", http.StatusMisdirectedRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		next.ServeHTTP(w, r)
	})
}

// handleOpen trades the one-time link for a session cookie and lands on the app.
func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	if s.hosted != nil {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("k")), []byte(s.secret)) != 1 {
		http.Error(w, "This link is out of date. Restart hotaisle-ui and use the link it prints.", http.StatusForbidden)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: s.secret, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Requested-With") != "hotaisle-ui" && !isWebSocket(r) {
			http.Error(w, "missing X-Requested-With header", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && o != "http://"+r.Host && (s.hosted == nil || o != "https://"+r.Host) {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		var a *account
		if s.hosted != nil {
			a = s.hosted.session(w, r)
		} else {
			c, err := r.Cookie(cookieName)
			if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.secret)) != 1 {
				http.Error(w, "not signed in to this hotaisle-ui session; open the link it printed", http.StatusUnauthorized)
				return
			}
			a = s.local
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, a)))
	})
}

func isWebSocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	a := acctOf(r)
	tok, inDemo := a.snapshot()
	if inDemo {
		a.demo.ServeHTTP(w, r)
		return
	}
	if tok == "" {
		http.Error(w, "no API token yet: connect an account or try the demo", http.StatusUnauthorized)
		return
	}
	s.proxy.ServeHTTP(w, r)
}

// ---------------------------------------------------------------- local endpoints

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleLocal(w http.ResponseWriter, r *http.Request) {
	a := acctOf(r)
	if s.hosted != nil && s.hosted.handle(s, w, r, a) {
		return
	}
	switch {
	case r.URL.Path == "/local/status" && r.Method == http.MethodGet:
		c := s.opt.Config
		tok, inDemo := a.snapshot()
		writeJSON(w, 200, map[string]any{
			"connected": tok != "", "token_source": c.TokenSource, "default_team": c.DefaultTeam,
			"team_source": c.TeamSource, "config_path": tildify(c.Path), "demo": inDemo, "version": s.opt.Version,
			"api_base": s.opt.APIBase, "hosted": false,
		})
	case r.URL.Path == "/local/demo" && r.Method == http.MethodPost:
		var req struct {
			On bool `json:"on"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req) != nil {
			http.Error(w, "body must be {\"on\": true|false}", 400)
			return
		}
		a.mu.Lock()
		a.inDemo = req.On
		a.mu.Unlock()
		writeJSON(w, 200, map[string]any{"demo": req.On})
	case r.URL.Path == "/local/token" && r.Method == http.MethodPost:
		s.saveToken(w, r)
	case r.URL.Path == "/local/team" && r.Method == http.MethodPost:
		var req struct {
			Team string `json:"team"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req) != nil || req.Team == "" {
			http.Error(w, "body must be {\"team\": \"handle\"}", 400)
			return
		}
		if _, inDemo := a.snapshot(); inDemo || s.opt.Config.TeamSource == "env" {
			writeJSON(w, 200, map[string]any{"saved": false})
			return
		}
		if err := s.opt.Config.Save(nil, &req.Team); err != nil {
			http.Error(w, "could not save the default team: "+err.Error(), 500)
			return
		}
		writeJSON(w, 200, map[string]any{"saved": true})
	case r.URL.Path == "/local/machines" && r.Method == http.MethodGet:
		writeJSON(w, 200, a.store().List(r.URL.Query().Get("team")))
	case r.URL.Path == "/local/machines" && r.Method == http.MethodPost:
		s.updateMachine(w, r)
	case r.URL.Path == "/local/history" && r.Method == http.MethodGet:
		writeJSON(w, 200, a.store().History(r.URL.Query().Get("team")))
	case r.URL.Path == "/local/history" && r.Method == http.MethodPost:
		var e state.Ended
		if json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&e) != nil || e.Team == "" || e.Name == "" {
			http.Error(w, "body must be {\"team\", \"name\", \"gpus\", \"ran_ms\", \"cents\", \"ended_at\"}", 400)
			return
		}
		if e.EndedAt.IsZero() {
			e.EndedAt = time.Now()
		}
		if err := a.store().AddEnded(e); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	case r.URL.Path == "/local/machines/prune" && r.Method == http.MethodPost:
		var req struct {
			Team  string   `json:"team"`
			Names []string `json:"names"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req) != nil || req.Team == "" {
			http.Error(w, "body must be {\"team\": \"handle\", \"names\": [...]}", 400)
			return
		}
		if err := a.store().Prune(req.Team, req.Names); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	case r.URL.Path == "/local/pubkeys" && r.Method == http.MethodGet:
		if _, inDemo := a.snapshot(); inDemo {
			// Sample keys, so a demo can be screen-recorded without showing anyone's real key comments.
			writeJSON(w, 200, demoPublicKeys())
			return
		}
		writeJSON(w, 200, localPublicKeys())
	default:
		http.NotFound(w, r)
	}
}

// saveToken checks a pasted token against the API, then stores it in the CLI's config file.
func (s *Server) saveToken(w http.ResponseWriter, r *http.Request) {
	tok, body, ok := s.checkToken(w, r)
	if !ok {
		return
	}
	if err := s.opt.Config.Save(&tok, nil); err != nil {
		http.Error(w, "token works, but saving it failed: "+err.Error(), 500)
		return
	}
	a := acctOf(r)
	a.mu.Lock()
	a.token = tok
	a.inDemo = false
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body) // the user and their teams, so the UI can go straight on
}

// checkToken reads a pasted token and asks the API who it belongs to. On failure it has answered.
func (s *Server) checkToken(w http.ResponseWriter, r *http.Request) (string, []byte, bool) {
	var req struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req) != nil {
		http.Error(w, "body must be {\"token\": \"...\"}", 400)
		return "", nil, false
	}
	tok := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(req.Token), "Token "))
	if tok == "" || strings.ContainsAny(tok, " \t\r\n") {
		http.Error(w, "That doesn't look like an API token. It is one line, with no spaces.", 400)
		return "", nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	out, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.opt.APIBase, "/")+"/user/", nil)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return "", nil, false
	}
	out.Header.Set("Authorization", "Token "+tok)
	out.Header.Set("Accept", "application/json")
	out.Header.Set("User-Agent", "hotaisle-ui/"+s.opt.Version)
	resp, err := s.client.Do(out)
	if err != nil {
		http.Error(w, "could not reach the Hot Aisle API: "+err.Error(), 502)
		return "", nil, false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		http.Error(w, "Hot Aisle didn't accept that token. Check you copied all of it, and that it hasn't been deleted.", 401)
		return "", nil, false
	}
	if resp.StatusCode != 200 {
		http.Error(w, fmt.Sprintf("the API answered %d: %s", resp.StatusCode, strings.TrimSpace(string(body))), 502)
		return "", nil, false
	}
	return tok, body, true
}

type pubKey struct {
	File          string `json:"file"`
	Type          string `json:"type"`
	Comment       string `json:"comment"`
	Fingerprint   string `json:"fingerprint"`
	AuthorizedKey string `json:"authorized_key"`
}

// localPublicKeys lists ~/.ssh/*.pub so the user can register one with a click. Only public halves.
func localPublicKeys() []pubKey {
	home, err := os.UserHomeDir()
	if err != nil {
		return []pubKey{}
	}
	paths, _ := filepath.Glob(filepath.Join(home, ".ssh", "*.pub"))
	out := []pubKey{}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil || len(b) > 16<<10 {
			continue
		}
		f := strings.Fields(strings.TrimSpace(string(b)))
		if len(f) < 2 {
			continue
		}
		blob, err := base64.StdEncoding.DecodeString(f[1])
		if err != nil {
			continue
		}
		sum := sha256.Sum256(blob)
		// Key comments are often an email address. Never show or upload them: label the key by
		// its file name instead.
		label := strings.TrimSuffix(filepath.Base(p), ".pub")
		out = append(out, pubKey{File: "~/.ssh/" + filepath.Base(p), Type: f[0], Comment: label,
			Fingerprint:   "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "="),
			AuthorizedKey: f[0] + " " + f[1] + " " + label})
	}
	return out
}

func demoPublicKeys() []pubKey {
	mk := func(seed byte, comment, file string) pubKey {
		blob := []byte{0, 0, 0, 11}
		blob = append(blob, "ssh-ed25519"...)
		blob = append(blob, 0, 0, 0, 32)
		for i := 0; i < 32; i++ {
			blob = append(blob, seed+byte(i*7))
		}
		b64 := base64.StdEncoding.EncodeToString(blob)
		sum := sha256.Sum256(blob)
		return pubKey{File: file, Type: "ssh-ed25519", Comment: comment,
			Fingerprint:   "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "="),
			AuthorizedKey: "ssh-ed25519 " + b64 + " " + comment}
	}
	return []pubKey{mk(3, "id_ed25519", "~/.ssh/id_ed25519.pub"), mk(91, "work_ed25519", "~/.ssh/work_ed25519.pub")}
}

// tildify shortens a path for display without revealing the account name: ~/... inside the home
// directory, otherwise just the file name.
func tildify(p string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, home+string(os.PathSeparator)) {
		return "~" + strings.TrimPrefix(p, home)
	}
	return filepath.Base(p)
}

// ---------------------------------------------------------------- static files

func (s *Server) static() http.Handler {
	files := http.FileServer(http.FS(s.opt.Static))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if _, err := fs.Stat(s.opt.Static, p); err == nil {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		// SPA: every other path is the app.
		b, err := fs.ReadFile(s.opt.Static, "index.html")
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "The web app isn't built. Run `make build` (or `cd web && npm ci && npm run build`).", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})
}

// ---------------------------------------------------------------- machine records and release timers

// updateMachine records a launch and/or sets or clears a release timer.
//
//	{"team": "t", "name": "vm", "launched": true, "image": "vllm", "price_cents": 598, "release_in_minutes": 120}
//
// release_in_minutes: a positive number sets the timer, 0 clears it, absent leaves it alone.
func (s *Server) updateMachine(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Team             string `json:"team"`
		Name             string `json:"name"`
		Launched         bool   `json:"launched"`
		Image            string `json:"image"`
		PriceCents       int64  `json:"price_cents"`
		ReleaseInMinutes *int   `json:"release_in_minutes"`
		GPUs             string `json:"gpus"`
		Metal            bool   `json:"metal"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req) != nil || req.Team == "" || req.Name == "" {
		http.Error(w, "body must name the team and the machine", 400)
		return
	}
	if req.ReleaseInMinutes != nil && (*req.ReleaseInMinutes < 0 || *req.ReleaseInMinutes > 60*24*14) {
		http.Error(w, "release_in_minutes must be between 0 and 20160", 400)
		return
	}
	m, err := acctOf(r).store().Update(req.Team, req.Name, func(m *state.Machine) {
		now := time.Now().UTC()
		if req.Launched && m.LaunchedAt == nil {
			m.LaunchedAt = &now
		}
		if req.Image != "" {
			m.Image = req.Image
		}
		if req.PriceCents > 0 {
			m.PriceCents = req.PriceCents
		}
		if req.GPUs != "" {
			m.GPUs = req.GPUs
		}
		if req.Metal {
			m.Metal = true
		}
		if req.ReleaseInMinutes != nil {
			if *req.ReleaseInMinutes == 0 {
				m.ReleaseAt = nil
			} else {
				at := now.Add(time.Duration(*req.ReleaseInMinutes) * time.Minute)
				m.ReleaseAt = &at
			}
			m.LastError = ""
		}
	})
	if err != nil {
		http.Error(w, "could not save: "+err.Error(), 500)
		return
	}
	writeJSON(w, 200, m)
}

// RunTimers releases machines whose timer has passed, every interval, until ctx ends.
// Timers only fire while this process runs; the UI says so.
func (s *Server) RunTimers(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.fireTimers(ctx)
		}
	}
}

// timerStore is one set of machine records whose timers fire: with the token to end them by, or the
// sample-data sandbox they live in.
type timerStore struct {
	st    *state.Store
	demo  *demo.API // set: sample data
	token string
}

func (s *Server) fireTimers(ctx context.Context) {
	now := time.Now()
	var stores []timerStore
	if s.hosted != nil {
		stores = s.hosted.timerStores(now)
	} else {
		tok, _ := s.local.snapshot()
		stores = []timerStore{{st: s.real, token: tok}, {st: s.sample, demo: s.demo}}
	}
	for _, pair := range stores {
		for _, m := range pair.st.Due(now) {
			code, msg := s.releaseVM(ctx, pair.demo, pair.token, m.Team, m.Name, m.Metal)
			switch {
			case code == http.StatusNoContent || code == http.StatusOK || code == http.StatusNotFound:
				if code != http.StatusNotFound {
					_ = pair.st.AddEnded(endedByTimer(m, now))
				}
				_ = pair.st.Remove(m.Team, m.Name)
			default:
				// Try again in a minute, and show why on the machine.
				_, _ = pair.st.Update(m.Team, m.Name, func(x *state.Machine) {
					next := now.Add(time.Minute)
					x.ReleaseAt = &next
					x.LastError = fmt.Sprintf("Auto-end didn't work (%d: %s). Trying again every minute.", code, msg)
				})
			}
		}
	}
}

// endedByTimer is the history entry for a machine auto-end has just ended: run time, and the cost at its
// price with the minimum reservation applied (30 minutes for a virtual machine, 8 hours for bare metal).
func endedByTimer(m state.Machine, now time.Time) state.Ended {
	e := state.Ended{Team: m.Team, Name: m.Name, GPUs: m.GPUs, EndedAt: now, StartedAt: m.LaunchedAt, Image: m.Image, PriceCents: m.PriceCents, Metal: m.Metal, By: "auto-end"}
	if m.LaunchedAt != nil {
		ran := now.Sub(*m.LaunchedAt)
		minimum := 30 * time.Minute
		if m.Metal {
			minimum = 8 * time.Hour
		}
		billed := ran
		if billed < minimum {
			billed, e.Minimum = minimum, true
		}
		e.RanMS = ran.Milliseconds()
		if m.PriceCents > 0 {
			e.Cents = float64(m.PriceCents) * billed.Hours()
		}
	}
	return e
}

// releaseVM ends a machine. A bare-metal server is released through its own endpoint, with force: you set
// the time, and its minimum reservation is charged either way.
func (s *Server) releaseVM(ctx context.Context, demoBackend *demo.API, token, team, name string, metal bool) (int, string) {
	path := "/teams/" + url.PathEscape(team) + "/virtual_machines/" + url.PathEscape(name) + "/"
	if metal {
		path = "/teams/" + url.PathEscape(team) + "/bare_metal/" + url.PathEscape(name) + "/?force=true"
	}
	if demoBackend != nil {
		rec := httptest.NewRecorder()
		demoBackend.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api"+path, nil))
		return rec.Code, strings.TrimSpace(rec.Body.String())
	}
	if token == "" {
		return 0, "no API token: sign in again so auto-end can end it"
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, strings.TrimRight(s.opt.APIBase, "/")+path, nil)
	if err != nil {
		return 0, err.Error()
	}
	req.Header.Set("Authorization", "Token "+token)
	req.Header.Set("User-Agent", "hotaisle-ui/"+s.opt.Version)
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, strings.TrimSpace(string(body))
}
