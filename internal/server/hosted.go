package server

// Hosted mode: one server, many people.
//
// Each visitor gets a session (a random id in an HttpOnly, SameSite=Strict cookie, Secure over HTTPS).
// The API token they paste lives in this process's memory, on their session, and nowhere else: it is
// never written to disk, never logged, never sent back to the page. Restarting the server signs
// everyone out. Sample data is a sandbox per session, made when first used and dropped when idle.
//
// Machine records (launch times, auto-end timers, the history of ended runs) belong to the account, so
// two sessions of one person see the same ones. With a data directory they are kept there, one file per
// account, named by a hash of the account's email; they never contain a token. Auto-end needs a token to
// end a machine, so an account's token is kept in memory while it has a session or a timer pending; after
// a restart, a pending timer waits for its owner to sign in again, and says so on the machine.
//
// The host's own Hot Aisle CLI login and ~/.ssh are never read.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"hotaisle-ui/internal/demo"
	"hotaisle-ui/internal/state"
)

const (
	sessionCookie = "hotaisle_ui_session"
	sessionIdle   = 12 * time.Hour // a signed-in session with no requests for this long is forgotten
	sampleIdle    = 2 * time.Hour  // a sample-data session, the same
	maxSessions   = 20000          // past this, the longest-idle sessions go first
)

// hostedUser is one Hot Aisle account, shared by all of its sessions.
type hostedUser struct {
	key   string
	store *state.Store
	token string // the latest token it signed in with; kept while it has a session or a timer pending
}

type hosted struct {
	opt      Options
	mu       sync.Mutex
	sessions map[string]*account
	users    map[string]*hostedUser
}

func newHosted(opt Options) *hosted {
	return &hosted{opt: opt, sessions: map[string]*account{}, users: map[string]*hostedUser{}}
}

func secureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// session finds the visitor's session, or starts one.
func (h *hosted) session(w http.ResponseWriter, r *http.Request) *account {
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	if c, err := r.Cookie(sessionCookie); err == nil {
		if a, ok := h.sessions[c.Value]; ok {
			a.mu.Lock()
			a.seen = now
			a.mu.Unlock()
			return a
		}
	}
	if len(h.sessions) >= maxSessions {
		h.evictLocked(len(h.sessions) - maxSessions + 1)
	}
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	real, _ := state.Open("")
	a := &account{real: real, seen: now}
	if h.opt.DemoOnly {
		a.inDemo = true
		a.demo, a.sample = demo.New(), mustMemoryStore()
	}
	h.sessions[id] = a
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: id, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: secureRequest(r)})
	return a
}

func mustMemoryStore() *state.Store {
	st, _ := state.Open("")
	return st
}

// evictLocked forgets the n longest-idle sessions.
func (h *hosted) evictLocked(n int) {
	type idle struct {
		id   string
		seen time.Time
	}
	all := make([]idle, 0, len(h.sessions))
	for id, a := range h.sessions {
		a.mu.Lock()
		all = append(all, idle{id, a.seen})
		a.mu.Unlock()
	}
	sort.Slice(all, func(i, j int) bool { return all[i].seen.Before(all[j].seen) })
	for i := 0; i < n && i < len(all); i++ {
		delete(h.sessions, all[i].id)
	}
}

// user finds or makes the record of an account, by a hash of its email (or, without one, of its token).
func (h *hosted) user(email, token string) *hostedUser {
	id := strings.ToLower(strings.TrimSpace(email))
	if id == "" {
		id = "token:" + token
	}
	sum := sha256.Sum256([]byte("hotaisle-ui account\x00" + id))
	key := hex.EncodeToString(sum[:16])
	h.mu.Lock()
	defer h.mu.Unlock()
	u, ok := h.users[key]
	if !ok {
		path := ""
		if h.opt.DataDir != "" {
			path = filepath.Join(h.opt.DataDir, key+".json")
		}
		st, err := state.Open(path)
		if err != nil {
			st = mustMemoryStore() // an unreadable file is never fatal to signing in
		}
		u = &hostedUser{key: key, store: st}
		h.users[key] = u
	}
	u.token = token
	return u
}

// timerStores forgets idle sessions, drops tokens nothing needs any more, and returns every set of
// records whose auto-end timers should be checked.
func (h *hosted) timerStores(now time.Time) []timerStore {
	h.mu.Lock()
	defer h.mu.Unlock()
	live := map[*hostedUser]bool{}
	var out []timerStore
	for id, a := range h.sessions {
		a.mu.Lock()
		limit := sessionIdle
		if a.token == "" {
			limit = sampleIdle
		}
		if now.Sub(a.seen) > limit {
			a.mu.Unlock()
			delete(h.sessions, id)
			continue
		}
		if a.user != nil {
			live[a.user] = true
		}
		if a.demo != nil {
			out = append(out, timerStore{st: a.sample, demo: a.demo})
		}
		a.mu.Unlock()
	}
	for _, u := range h.users {
		if !live[u] && !u.store.Pending() {
			u.token = ""
		}
		out = append(out, timerStore{st: u.store, token: u.token})
	}
	return out
}

func (h *hosted) signOut(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		h.mu.Lock()
		if a, ok := h.sessions[c.Value]; ok {
			a.mu.Lock()
			a.token, a.user = "", nil
			a.mu.Unlock()
			delete(h.sessions, c.Value)
		}
		h.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: secureRequest(r)})
}

// handle answers the /local/ calls that differ when hosted; it reports whether it did.
func (h *hosted) handle(s *Server, w http.ResponseWriter, r *http.Request, a *account) bool {
	switch {
	case r.URL.Path == "/local/status" && r.Method == http.MethodGet:
		a.mu.Lock()
		st := map[string]any{
			"connected": a.token != "", "token_source": "session", "default_team": a.team, "team_source": "session",
			"config_path": "", "demo": a.inDemo, "version": s.opt.Version, "api_base": s.opt.APIBase,
			"hosted": true, "demo_only": h.opt.DemoOnly,
		}
		a.mu.Unlock()
		writeJSON(w, 200, st)
	case r.URL.Path == "/local/demo" && r.Method == http.MethodPost:
		var req struct {
			On bool `json:"on"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req) != nil {
			http.Error(w, "body must be {\"on\": true|false}", 400)
			return true
		}
		if h.opt.DemoOnly && !req.On {
			http.Error(w, "This is a demo site: sample data only.", http.StatusForbidden)
			return true
		}
		a.mu.Lock()
		a.inDemo = req.On
		if req.On && a.demo == nil {
			a.demo, a.sample = demo.New(), mustMemoryStore()
		}
		a.mu.Unlock()
		writeJSON(w, 200, map[string]any{"demo": req.On})
	case r.URL.Path == "/local/token" && r.Method == http.MethodPost:
		if h.opt.DemoOnly {
			http.Error(w, "This is a demo site with sample data. To use your account, run hotaisle-ui on your own computer.", http.StatusForbidden)
			return true
		}
		tok, body, ok := s.checkToken(w, r)
		if !ok {
			return true
		}
		var who struct {
			User struct {
				Email string `json:"email"`
			} `json:"user"`
		}
		_ = json.Unmarshal(body, &who)
		u := h.user(who.User.Email, tok)
		a.mu.Lock()
		a.token, a.user, a.real, a.inDemo = tok, u, u.store, false
		a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	case r.URL.Path == "/local/team" && r.Method == http.MethodPost:
		var req struct {
			Team string `json:"team"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req) != nil || req.Team == "" {
			http.Error(w, "body must be {\"team\": \"handle\"}", 400)
			return true
		}
		a.mu.Lock()
		a.team = req.Team
		a.mu.Unlock()
		writeJSON(w, 200, map[string]any{"saved": true})
	case r.URL.Path == "/local/pubkeys" && r.Method == http.MethodGet:
		// never the host's keys; visitors paste theirs
		if _, inDemo := a.snapshot(); inDemo {
			writeJSON(w, 200, demoPublicKeys())
		} else {
			writeJSON(w, 200, []pubKey{})
		}
	case r.URL.Path == "/local/signout" && r.Method == http.MethodPost:
		h.signOut(w, r)
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		return false
	}
	return true
}
