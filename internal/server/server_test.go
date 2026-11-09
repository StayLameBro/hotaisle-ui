package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"hotaisle-ui/internal/config"
	"hotaisle-ui/internal/state"
)

// newTestServer returns a running app server and its session cookie, wired to a fake upstream API.
func newTestServer(t *testing.T, upstream http.Handler, demo bool) (*Server, string, *http.Cookie) {
	t.Helper()
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)
	cfgPath := filepath.Join(t.TempDir(), "config.json")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	cfg.APIToken = "tok-123"
	s, err := New(Options{APIBase: up.URL + "/api", Config: cfg, StartDemo: demo, Version: "test",
		Static: fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>t</title>")}}})
	if err != nil {
		t.Fatal(err)
	}
	ln, link, err := s.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	hs := &http.Server{Handler: s.Handler()}
	go hs.Serve(ln)
	t.Cleanup(func() { hs.Close() })
	// Follow the one-time link to get the session cookie.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(link)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var c *http.Cookie
	for _, k := range resp.Cookies() {
		if k.Name == cookieName {
			c = k
		}
	}
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("open link did not set a strict, HttpOnly session cookie: %+v", c)
	}
	return s, "http://" + ln.Addr().String(), c
}

func do(t *testing.T, method, url string, c *http.Cookie, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	if c != nil {
		req.AddCookie(c)
	}
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestGuard(t *testing.T) {
	var gotAuth, gotCookie, gotPath string
	up := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotCookie, gotPath = r.Header.Get("Authorization"), r.Header.Get("Cookie"), r.URL.Path
		w.Write([]byte(`[]`))
	})
	_, base, c := newTestServer(t, up, false)
	ok := map[string]string{"X-Requested-With": "hotaisle-ui"}

	cases := []struct {
		name   string
		cookie *http.Cookie
		hdr    map[string]string
		want   int
	}{
		{"no cookie", nil, ok, 401},
		{"wrong cookie", &http.Cookie{Name: cookieName, Value: "nope"}, ok, 401},
		{"no custom header", c, nil, 403},
		{"cross-origin", c, map[string]string{"X-Requested-With": "hotaisle-ui", "Origin": "https://evil.example"}, 403},
		{"foreign Host (DNS rebinding)", c, map[string]string{"X-Requested-With": "hotaisle-ui", "Host": "evil.example"}, 421},
		{"allowed", c, ok, 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := do(t, "GET", base+"/api/teams/", tc.cookie, tc.hdr).StatusCode; got != tc.want {
				t.Fatalf("status %d, want %d", got, tc.want)
			}
		})
	}
	if gotAuth != "Token tok-123" {
		t.Errorf("upstream Authorization = %q", gotAuth)
	}
	if gotCookie != "" {
		t.Errorf("session cookie leaked upstream: %q", gotCookie)
	}
	if gotPath != "/api/teams/" {
		t.Errorf("upstream path = %q", gotPath)
	}
}

func TestBadOpenLink(t *testing.T) {
	_, base, _ := newTestServer(t, http.NotFoundHandler(), false)
	if got := do(t, "GET", base+"/open?k=guess", nil, nil).StatusCode; got != 403 {
		t.Fatalf("status %d, want 403", got)
	}
}

func TestListensOnLoopbackOnly(t *testing.T) {
	s, _, _ := newTestServer(t, http.NotFoundHandler(), false)
	host, _, _ := net.SplitHostPort(s.addr)
	if host != "127.0.0.1" {
		t.Fatalf("listening on %s", host)
	}
}

func TestDemoKeysNeverShowRealComments(t *testing.T) {
	_, base, c := newTestServer(t, http.NotFoundHandler(), true)
	resp := do(t, "GET", base+"/local/pubkeys", c, map[string]string{"X-Requested-With": "hotaisle-ui"})
	var keys []pubKey
	if err := json.NewDecoder(resp.Body).Decode(&keys); err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		if strings.Contains(k.Comment, "@") || strings.Contains(k.AuthorizedKey, "@") {
			t.Fatalf("demo key shows an address: %+v", k)
		}
	}
}

func TestLocalKeysDropComments(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	key := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQxuQk1cH8WkaQ3w6cABiyfRruEmtY280ryshxbN5f3 someone@example.com"
	os.WriteFile(filepath.Join(home, ".ssh", "id_ed25519.pub"), []byte(key+"\n"), 0o644)
	keys := localPublicKeys()
	if len(keys) != 1 {
		t.Fatalf("got %d keys", len(keys))
	}
	if strings.Contains(keys[0].Comment+keys[0].AuthorizedKey, "example.com") {
		t.Fatalf("key comment leaked: %+v", keys[0])
	}
	if keys[0].AuthorizedKey != "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQxuQk1cH8WkaQ3w6cABiyfRruEmtY280ryshxbN5f3 id_ed25519" {
		t.Fatalf("authorized key = %q", keys[0].AuthorizedKey)
	}
	if !strings.HasPrefix(keys[0].Fingerprint, "SHA256:") {
		t.Fatalf("fingerprint = %q", keys[0].Fingerprint)
	}
}

func TestReleaseTimers(t *testing.T) {
	s, _, _ := newTestServer(t, http.NotFoundHandler(), true)
	past := time.Now().Add(-time.Second)
	// A machine that no longer exists: the timer clears itself.
	s.sample.Update("demo-lab", "gone", func(m *state.Machine) { m.ReleaseAt = &past })
	// A machine inside its minimum reservation: the release fails, the timer retries and says why.
	key := `{"authorized_key":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQxuQk1cH8WkaQ3w6cABiyfRruEmtY280ryshxbN5f3 k"}`
	call := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.demo.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}
	call("POST", "/api/user/ssh_keys/", key)
	var vm struct{ Name string }
	json.Unmarshal(call("POST", "/api/teams/demo-lab/virtual_machines/", `{"gpus":[{"count":1}]}`).Body.Bytes(), &vm)
	s.sample.Update("demo-lab", vm.Name, func(m *state.Machine) { m.ReleaseAt = &past })

	s.fireTimers(context.Background())

	got := s.sample.List("demo-lab")
	if len(got) != 1 || got[0].Name != vm.Name {
		t.Fatalf("records after firing: %+v", got)
	}
	if got[0].LastError == "" || got[0].ReleaseAt == nil || !got[0].ReleaseAt.After(time.Now()) {
		t.Fatalf("failed release should retry later with a reason: %+v", got[0])
	}
}

func TestHistoryRoundTrip(t *testing.T) {
	_, base, c := newTestServer(t, http.NotFoundHandler(), true)
	post := func(body string) int {
		req, _ := http.NewRequest("POST", base+"/local/history", strings.NewReader(body))
		req.AddCookie(c)
		req.Header.Set("X-Requested-With", "hotaisle-ui")
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := post(`{"team":"demo-lab","name":"enc1-a","gpus":"2× MI300X","ran_ms":60000,"cents":299}`); code != 200 {
		t.Fatalf("post: %d", code)
	}
	if code := post(`{"name":"no-team"}`); code != 400 {
		t.Fatalf("post without team: %d", code)
	}
	resp := do(t, "GET", base+"/local/history?team=demo-lab", c, map[string]string{"X-Requested-With": "hotaisle-ui"})
	var got []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0]["name"] != "enc1-a" || got[0]["ended_at"] == "" {
		t.Fatalf("history: %+v", got)
	}
}

// Auto-end on a bare-metal server goes through the bare-metal endpoint (with force: the minimum is charged
// either way), really releases it, and puts the run in the history.
func TestReleaseTimerBareMetal(t *testing.T) {
	s, _, _ := newTestServer(t, http.NotFoundHandler(), true)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.demo.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}
	var srv struct{ Name string }
	json.Unmarshal(call("POST", "/api/teams/demo-lab/bare_metal/", `{"specs":{}}`).Body.Bytes(), &srv)
	if srv.Name == "" {
		t.Fatal("no server reserved")
	}
	past := time.Now().Add(-time.Second)
	launched := time.Now().Add(-2 * time.Hour)
	s.sample.Update("demo-lab", srv.Name, func(m *state.Machine) {
		m.ReleaseAt, m.LaunchedAt, m.Metal, m.GPUs, m.PriceCents = &past, &launched, true, "8× MI300X", 2712
	})

	s.fireTimers(context.Background())

	var left []any
	json.Unmarshal(call("GET", "/api/teams/demo-lab/bare_metal/", "").Body.Bytes(), &left)
	if len(left) != 0 {
		t.Fatalf("server still reserved after auto-end: %v", left)
	}
	if got := s.sample.List("demo-lab"); len(got) != 0 {
		t.Fatalf("record kept after a successful auto-end: %+v", got)
	}
	h := s.sample.History("demo-lab")
	if len(h) != 1 || h[0].By != "auto-end" || !h[0].Metal || !h[0].Minimum || h[0].Cents != 2712*8 || h[0].GPUs != "8× MI300X" {
		t.Fatalf("history after auto-end: %+v", h)
	}
}

func TestSecretSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ui-session")
	a, err := loadSecret(path)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := loadSecret(path)
	if a != b || len(a) != 48 {
		t.Fatalf("a restart made a new secret: %q then %q", a, b)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("secret file must be 0600: %v %v", fi.Mode(), err)
	}
	if c, _ := loadSecret(""); c == a || len(c) != 48 {
		t.Fatalf("no path must mean a fresh secret")
	}
	os.WriteFile(path, []byte("not-hex\n"), 0o600)
	if d, _ := loadSecret(path); d == a || len(d) != 48 {
		t.Fatalf("a damaged file must be replaced: %q", d)
	}
}
