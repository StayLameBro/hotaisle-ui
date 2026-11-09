package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"hotaisle-ui/internal/config"
	"hotaisle-ui/internal/state"
)

// upstream is a fake Hot Aisle API that knows two tokens and records which token each call carried.
type upstream struct {
	mu    sync.Mutex
	calls []string // "METHOD path token"
}

func (u *upstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Token ")
	u.mu.Lock()
	u.calls = append(u.calls, r.Method+" "+r.URL.Path+" "+tok)
	u.mu.Unlock()
	emails := map[string]string{"tok-alice": "alice@example.com", "tok-bob": "bob@example.com"}
	email, ok := emails[tok]
	if !ok {
		http.Error(w, "bad token", 401)
		return
	}
	switch {
	case r.URL.Path == "/api/user/":
		_ = json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"email": email}, "teams": []any{}})
	case r.Method == http.MethodDelete:
		w.WriteHeader(http.StatusNoContent)
	default:
		_ = json.NewEncoder(w).Encode(map[string]any{"who": email})
	}
}

func (u *upstream) saw(want string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, c := range u.calls {
		if c == want {
			return true
		}
	}
	return false
}

func newHostedServer(t *testing.T, up http.Handler, opt Options) (*Server, string) {
	t.Helper()
	api := httptest.NewServer(up)
	t.Cleanup(api.Close)
	opt.APIBase = api.URL + "/api"
	opt.Config = &config.Config{}
	opt.Hosted = true
	opt.Version = "test"
	opt.Static = fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>t</title>")}}
	s, err := New(opt)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := s.ListenHosted("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	hs := &http.Server{Handler: s.Handler()}
	go hs.Serve(ln)
	t.Cleanup(func() { hs.Close() })
	return s, "http://" + ln.Addr().String()
}

// visitor is one browser: its own cookie jar.
type visitor struct {
	t    *testing.T
	base string
	c    *http.Client
}

func newVisitor(t *testing.T, base string) *visitor {
	jar, _ := cookiejar.New(nil)
	return &visitor{t, base, &http.Client{Jar: jar}}
}

func (v *visitor) call(method, path, body string, hdr ...string) (int, string) {
	v.t.Helper()
	req, _ := http.NewRequest(method, v.base+path, strings.NewReader(body))
	req.Header.Set("X-Requested-With", "hotaisle-ui")
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := v.c.Do(req)
	if err != nil {
		v.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestHostedVisitorsNeverShareAToken(t *testing.T) {
	up := &upstream{}
	_, base := newHostedServer(t, up, Options{})
	alice, bob, carol := newVisitor(t, base), newVisitor(t, base), newVisitor(t, base)
	if code, body := alice.call("POST", "/local/token", `{"token":"tok-alice"}`); code != 200 {
		t.Fatalf("alice signs in: %d %s", code, body)
	}
	if code, body := bob.call("POST", "/local/token", `{"token":"tok-bob"}`); code != 200 {
		t.Fatalf("bob signs in: %d %s", code, body)
	}
	if _, body := alice.call("GET", "/api/teams/x/virtual_machines/", ""); !strings.Contains(body, "alice@") {
		t.Fatalf("alice's call went out as someone else: %s", body)
	}
	if _, body := bob.call("GET", "/api/teams/x/virtual_machines/", ""); !strings.Contains(body, "bob@") {
		t.Fatalf("bob's call went out as someone else: %s", body)
	}
	if code, _ := carol.call("GET", "/api/teams/x/virtual_machines/", ""); code != 401 {
		t.Fatalf("a visitor who hasn't signed in reached the API: %d", code)
	}
	if _, body := carol.call("GET", "/local/status", ""); !strings.Contains(body, `"connected":false`) || !strings.Contains(body, `"hosted":true`) {
		t.Fatalf("status for a new visitor: %s", body)
	}
	// the token never comes back to the page
	if _, body := alice.call("GET", "/local/status", ""); strings.Contains(body, "tok-alice") {
		t.Fatalf("the token reached the page: %s", body)
	}
}

func TestHostedNeverReadsTheHostsKeysOrLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	os.WriteFile(filepath.Join(home, ".ssh", "id_ed25519.pub"), []byte("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQxuQk1cH8WkaQ3w6cABiyfRruEmtY280ryshxbN5f3 host-owner@example.com\n"), 0o600)
	_, base := newHostedServer(t, &upstream{}, Options{})
	v := newVisitor(t, base)
	v.call("POST", "/local/token", `{"token":"tok-alice"}`)
	if _, body := v.call("GET", "/local/pubkeys", ""); strings.TrimSpace(body) != "[]" {
		t.Fatalf("a visitor saw the host's SSH keys: %s", body)
	}
	if _, body := v.call("GET", "/local/status", ""); strings.Contains(body, home) || strings.Contains(body, ".hotaisle") {
		t.Fatalf("status shows the host's files: %s", body)
	}
}

func TestHostedRecordsNeverHoldATokenAndSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	up := &upstream{}
	_, base := newHostedServer(t, up, Options{DataDir: dir})
	v := newVisitor(t, base)
	v.call("POST", "/local/token", `{"token":"tok-alice"}`)
	if code, body := v.call("POST", "/local/machines", `{"team":"lab","name":"vm1","launched":true,"gpus":"1× MI300X"}`); code != 200 {
		t.Fatalf("record a launch: %d %s", code, body)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*"))
	if len(files) != 1 {
		t.Fatalf("want one record file, got %v", files)
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), "tok-alice") || strings.Contains(string(b), "alice@") {
			t.Fatalf("%s holds the token or the email: %s", f, b)
		}
	}
	// a new server on the same directory: signing in again brings the records back
	_, base2 := newHostedServer(t, up, Options{DataDir: dir})
	v2 := newVisitor(t, base2)
	v2.call("POST", "/local/token", `{"token":"tok-alice"}`)
	if _, body := v2.call("GET", "/local/machines?team=lab", ""); !strings.Contains(body, "vm1") {
		t.Fatalf("records lost across a restart: %s", body)
	}
	// and someone else's sign-in doesn't see them
	v3 := newVisitor(t, base2)
	v3.call("POST", "/local/token", `{"token":"tok-bob"}`)
	if _, body := v3.call("GET", "/local/machines?team=lab", ""); strings.Contains(body, "vm1") {
		t.Fatalf("bob sees alice's machines: %s", body)
	}
}

func TestHostedDemoSiteRefusesRealTokens(t *testing.T) {
	up := &upstream{}
	_, base := newHostedServer(t, up, Options{DemoOnly: true})
	v := newVisitor(t, base)
	if code, _ := v.call("POST", "/local/token", `{"token":"tok-alice"}`); code != 403 {
		t.Fatalf("a demo site took a real token: %d", code)
	}
	if code, _ := v.call("POST", "/local/demo", `{"on":false}`); code != 403 {
		t.Fatalf("a demo site left sample data: %d", code)
	}
	if code, body := v.call("GET", "/api/user/", ""); code != 200 || !strings.Contains(body, "demo@example.com") {
		t.Fatalf("a demo visitor should get sample data: %d %s", code, body)
	}
	if len(up.calls) != 0 {
		t.Fatalf("a demo site called the real API: %v", up.calls)
	}
	// each visitor has a sandbox of their own
	other := newVisitor(t, base)
	v.call("POST", "/local/machines", `{"team":"demo-lab","name":"mine","launched":true}`)
	if _, body := other.call("GET", "/local/machines?team=demo-lab", ""); strings.Contains(body, "mine") {
		t.Fatalf("sample sandboxes are shared: %s", body)
	}
}

func TestHostedSignOutForgetsTheToken(t *testing.T) {
	_, base := newHostedServer(t, &upstream{}, Options{})
	v := newVisitor(t, base)
	v.call("POST", "/local/token", `{"token":"tok-alice"}`)
	if code, _ := v.call("POST", "/local/signout", ""); code != 200 {
		t.Fatalf("sign out: %d", code)
	}
	if code, _ := v.call("GET", "/api/teams/x/virtual_machines/", ""); code != 401 {
		t.Fatalf("still signed in after signing out: %d", code)
	}
}

func TestHostedCookieAndOrigin(t *testing.T) {
	_, base := newHostedServer(t, &upstream{}, Options{})
	req, _ := http.NewRequest("GET", base+"/local/status", nil)
	req.Header.Set("X-Requested-With", "hotaisle-ui")
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var c *http.Cookie
	for _, k := range resp.Cookies() {
		if k.Name == sessionCookie {
			c = k
		}
	}
	if c == nil || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie behind HTTPS must be HttpOnly, Secure and SameSite=Strict: %+v", c)
	}
	v := newVisitor(t, base)
	host := strings.TrimPrefix(base, "http://")
	if code, _ := v.call("GET", "/local/status", "", "Origin", "https://"+host); code != 200 {
		t.Fatalf("same-origin over HTTPS refused: %d", code)
	}
	if code, _ := v.call("GET", "/local/status", "", "Origin", "https://evil.example"); code != 403 {
		t.Fatalf("cross-origin call allowed: %d", code)
	}
	if code, _ := v.call("GET", "/local/status", "", "X-Requested-With", ""); code != 403 {
		t.Fatalf("call without the custom header allowed: %d", code)
	}
}

func TestHostedPublicHostIsEnforced(t *testing.T) {
	_, base := newHostedServer(t, &upstream{}, Options{Host: "ui.example.com"})
	v := newVisitor(t, base)
	if code, _ := v.call("GET", "/local/status", ""); code != http.StatusMisdirectedRequest {
		t.Fatalf("wrong Host accepted: %d", code)
	}
}

func TestHostedAutoEndUsesTheOwnersToken(t *testing.T) {
	up := &upstream{}
	s, base := newHostedServer(t, up, Options{})
	v := newVisitor(t, base)
	v.call("POST", "/local/token", `{"token":"tok-alice"}`)
	v.call("POST", "/local/machines", `{"team":"lab","name":"vm9","launched":true,"release_in_minutes":1}`)
	// the visitor closes the tab: the session idles out, but the pending timer keeps the token
	for _, a := range s.hosted.sessions {
		a.seen = time.Now().Add(-sessionIdle - time.Minute)
	}
	u := func() *hostedUser {
		for _, u := range s.hosted.users {
			return u
		}
		return nil
	}()
	past := time.Now().Add(-time.Second)
	u.store.Update("lab", "vm9", func(m *state.Machine) { m.ReleaseAt = &past })
	s.fireTimers(context.Background())
	if !up.saw("DELETE /api/teams/lab/virtual_machines/vm9/ tok-alice") {
		t.Fatalf("auto-end did not end the machine with its owner's token: %v", up.calls)
	}
	if len(s.hosted.sessions) != 0 {
		t.Fatalf("an idle session was kept")
	}
	// with nothing pending and no session, the token is forgotten
	s.fireTimers(context.Background())
	if u.token != "" {
		t.Fatalf("a token was kept with nothing needing it")
	}
}
