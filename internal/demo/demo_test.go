package demo

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func call(t *testing.T, a *API, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	a.ServeHTTP(w, req)
	return w
}

func TestLifecycle(t *testing.T) {
	a := New()
	// No SSH key yet: the real API answers 428.
	if w := call(t, a, "POST", "/api/teams/demo-lab/virtual_machines/", `{"gpus":[{"count":1,"model":"MI300X"}]}`); w.Code != 428 {
		t.Fatalf("provision without key: %d", w.Code)
	}
	key := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBQxuQk1cH8WkaQ3w6cABiyfRruEmtY280ryshxbN5f3 id_ed25519"
	if w := call(t, a, "POST", "/api/user/ssh_keys/", `{"authorized_key":"`+key+`"}`); w.Code != 200 {
		t.Fatalf("add key: %d %s", w.Code, w.Body)
	}
	if w := call(t, a, "POST", "/api/user/ssh_keys/", `{"authorized_key":"`+key+`"}`); w.Code != 409 {
		t.Fatalf("duplicate key: %d", w.Code)
	}
	w := call(t, a, "POST", "/api/teams/demo-lab/virtual_machines/", `{"gpus":[{"count":2,"model":"MI300X"}]}`)
	if w.Code != 200 {
		t.Fatalf("provision: %d %s", w.Code, w.Body)
	}
	var vm struct {
		Name      string `json:"name"`
		Status    string `json:"status"`
		SSHAccess struct {
			Port int `json:"port"`
		} `json:"ssh_access"`
		GPUs []struct {
			Count int `json:"count"`
		} `json:"gpus"`
	}
	json.Unmarshal(w.Body.Bytes(), &vm)
	if vm.Name == "" || vm.Status != "ready" || vm.SSHAccess.Port == 0 || vm.GPUs[0].Count != 2 {
		t.Fatalf("vm %+v", vm)
	}
	var bal struct {
		HourlyRate float64 `json:"hourly_rate"`
	}
	json.Unmarshal(call(t, a, "GET", "/api/teams/demo-lab/balance/", "").Body.Bytes(), &bal)
	if bal.HourlyRate != 598 {
		t.Fatalf("hourly rate %v, want 598", bal.HourlyRate)
	}
	// Inside the minimum reservation: refused without force, accepted with it.
	if w := call(t, a, "DELETE", "/api/teams/demo-lab/virtual_machines/"+vm.Name+"/", ""); w.Code != 400 || !strings.Contains(w.Body.String(), "minimum reservation") {
		t.Fatalf("early release: %d %s", w.Code, w.Body)
	}
	if w := call(t, a, "DELETE", "/api/teams/demo-lab/virtual_machines/"+vm.Name+"/?force=true", ""); w.Code != http.StatusNoContent {
		t.Fatalf("forced release: %d", w.Code)
	}
	if w := call(t, a, "GET", "/api/teams/demo-lab/virtual_machines/", ""); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("list after release: %s", w.Body)
	}
}

func TestUnknownTeam(t *testing.T) {
	if w := call(t, New(), "GET", "/api/teams/someone-else/balance/", ""); w.Code != 404 {
		t.Fatalf("got %d", w.Code)
	}
}

func TestMachinesLandOnServersWithRoom(t *testing.T) {
	a := New()
	a.keys = append(a.keys, sshKey{Type: "ssh-ed25519", PublicKey: "AAAA", Fingerprint: "SHA256:x"})
	hostOf := func(n int) string {
		rec := httptest.NewRecorder()
		a.ServeHTTP(rec, httptest.NewRequest("POST", "/api/teams/demo-lab/virtual_machines/", strings.NewReader(fmt.Sprintf(`{"gpus":[{"count":%d,"model":"MI300X"}]}`, n))))
		if rec.Code != 200 {
			t.Fatalf("provision %d: %d %s", n, rec.Code, rec.Body)
		}
		var v struct{ Name string }
		json.NewDecoder(rec.Body).Decode(&v)
		rec = httptest.NewRecorder()
		a.ServeHTTP(rec, httptest.NewRequest("GET", "/api/teams/demo-lab/virtual_machines/"+v.Name+"/state/", nil))
		var st struct{ Host string }
		json.NewDecoder(rec.Body).Decode(&st)
		return st.Host
	}
	// Machines go where the app's preview puts them: next to your others while there is room, else onto a
	// free server (never in among another customer's GPUs while a free server is left).
	for i, want := range []struct {
		n    int
		host string
	}{{4, "enc1-host-07"}, {4, "enc1-host-07"}, {2, "enc1-host-15"}, {2, "enc1-host-15"}} {
		if h := hostOf(want.n); h != want.host {
			t.Fatalf("machine %d (%d GPUs) went to %s, want %s", i+1, want.n, h, want.host)
		}
	}
}

// A bare-metal reservation takes a whole free server, installs, and gives the server back when released.
func TestBareMetal(t *testing.T) {
	a := New()
	var avail []struct {
		Quantity                  int `json:"Quantity"`
		MinimumReservationMinutes int `json:"MinimumReservationMinutes"`
		OnDemandPrice             int `json:"OnDemandPrice"`
	}
	json.Unmarshal(call(t, a, "GET", "/api/teams/demo-lab/bare_metal/available/", "").Body.Bytes(), &avail)
	if len(avail) != 1 || avail[0].Quantity != 2 || avail[0].MinimumReservationMinutes != 480 || avail[0].OnDemandPrice != 2712 {
		t.Fatalf("available: %+v", avail)
	}
	w := call(t, a, "POST", "/api/teams/demo-lab/bare_metal/", `{"specs":{}}`)
	if w.Code != 201 {
		t.Fatalf("reserve: %d %s", w.Code, w.Body)
	}
	var s struct {
		Name     string `json:"name"`
		OSStatus struct {
			Stage string `json:"os_install_status"`
		} `json:"os_status"`
	}
	json.Unmarshal(w.Body.Bytes(), &s)
	if s.Name != "enc1-host-07" || s.OSStatus.Stage != "shutting_down" {
		t.Fatalf("reserved %+v: want the only fully free server, just starting its install", s)
	}
	// The other whole server, then none left; and no room on a reserved one for a virtual machine either.
	if w := call(t, a, "POST", "/api/teams/demo-lab/bare_metal/", `{"specs":{}}`); w.Code != 201 {
		t.Fatalf("second reserve: %d", w.Code)
	}
	if w := call(t, a, "POST", "/api/teams/demo-lab/bare_metal/", `{"specs":{}}`); w.Code != 404 {
		t.Fatalf("third reserve: %d", w.Code)
	}
	if a.hosts[0].free() != 0 {
		t.Fatalf("server still has %d free GPUs", a.hosts[0].free())
	}
	// Released inside the minimum: refused without force, the server freed with it.
	if w := call(t, a, "DELETE", "/api/teams/demo-lab/bare_metal/"+s.Name+"/", ""); w.Code != 400 {
		t.Fatalf("early release: %d", w.Code)
	}
	if w := call(t, a, "DELETE", "/api/teams/demo-lab/bare_metal/"+s.Name+"/?force=true", ""); w.Code != 204 {
		t.Fatalf("forced release: %d %s", w.Code, w.Body)
	}
	if a.hosts[0].free() != 8 || len(a.metal) != 1 {
		t.Fatalf("after release: %d free, %d servers", a.hosts[0].free(), len(a.metal))
	}
}
