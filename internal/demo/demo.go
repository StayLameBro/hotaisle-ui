// Package demo is an in-memory stand-in for the Hot Aisle API, so the UI can be tried, developed and
// recorded without an account and without spending money. It follows the shapes in the public
// OpenAPI document (https://admin.hotaisle.app/api/docs/swagger.json). Prices and specs mirror the
// public pricing page; timings are made up and kept short.
package demo

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	gib  = int64(1) << 30
	tb   = int64(1000) * 1000 * 1000 * 1000
	team = "demo-lab"
)

type gpu struct {
	Count        int64  `json:"count"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
}

type specs struct {
	CPUCores     int64          `json:"cpu_cores"`
	RAMCapacity  int64          `json:"ram_capacity"`
	DiskCapacity int64          `json:"disk_capacity"`
	GPUs         []gpu          `json:"gpus,omitempty"`
	CPUs         map[string]any `json:"cpus,omitempty"`
}

type offer struct {
	Quantity                  int64 `json:"Quantity"`
	MinimumReservationMinutes int64 `json:"MinimumReservationMinutes"`
	OnDemandPrice             int64 `json:"OnDemandPrice"`
	Specs                     specs `json:"Specs"`
}

type sshAccess struct {
	IPAddress string `json:"ip_address"`
	Port      int64  `json:"port"`
	DNSName   string `json:"dns_name,omitempty"`
}

type vm struct {
	Name         string     `json:"name"`
	DeploymentID string     `json:"deployment_id"`
	Description  string     `json:"description"`
	IPAddress    string     `json:"ip_address"`
	Status       string     `json:"status"`
	SSHAccess    *sshAccess `json:"ssh_access,omitempty"`
	specs

	price     int64     // cents per hour
	host      *host     // the server it runs on
	slots     []int     // which of that server's eight GPUs it holds
	created   time.Time // for the minimum reservation check
	readyAt   time.Time // status flips to ready (custom cloud-init builds take longer)
	runningAt time.Time // power state flips to running
	powered   bool
}

// server is a bare-metal reservation: a whole 8-GPU server, its operating system installed from scratch.
type server struct {
	Name         string     `json:"name"`
	DeploymentID string     `json:"deployment_id"`
	Description  string     `json:"description"`
	IPAddress    string     `json:"ip_address"`
	Manufacturer string     `json:"manufacturer"`
	Model        string     `json:"model"`
	SSHAccess    *sshAccess `json:"ssh_access,omitempty"`

	host      *host
	price     int64     // cents per hour
	created   time.Time // for the minimum reservation
	installAt time.Time // when the current install began
	off       bool
}

// metalMinimum is how long a bare-metal reservation is billed for at least (the API's 480 minutes).
const metalMinimum = 8 * time.Hour

// installStages is the order a bare-metal install reports, and when each starts (sped up for the demo).
var installStages = []struct {
	at    time.Duration
	stage string
}{
	{0, "shutting_down"}, {2 * time.Second, "ac_reset"}, {4 * time.Second, "bios_reset"}, {6 * time.Second, "booting_installer"},
	{9 * time.Second, "installing_os"}, {15 * time.Second, "finalizing_os"}, {18 * time.Second, "first_boot"},
	{21 * time.Second, "first_boot_tasks"}, {24 * time.Second, "installed"},
}

func (s *server) stage(now time.Time) string {
	st := installStages[0].stage
	for _, x := range installStages {
		if now.Sub(s.installAt) >= x.at {
			st = x.stage
		}
	}
	return st
}

// metalSpecs is what one XE9680 offers as bare metal: eight MI300X, two Xeon Platinum 8470, 2 TB, 122 TB of NVMe.
func metalSpecs() map[string]any {
	return map[string]any{
		"cpu_cores": 104, "ram_capacity": 2048 * gib, "disk_capacity": 8 * 15360 * 1000 * 1000 * 1000,
		"gpus": []gpu{{Count: 8, Manufacturer: "AMD", Model: "MI300X"}},
		"cpus": []map[string]any{{"count": 2, "manufacturer": "Intel", "model": "Xeon Platinum 8470", "cores": 52, "frequency": 2000000000}},
	}
}

type sshKey struct {
	Type        string `json:"type"`
	PublicKey   string `json:"public_key"`
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment,omitempty"`
}

// host is one 8-GPU server. A GPU slot is free (""), held by someone else ("-"), or held by a VM (its name).
type host struct {
	name  string
	slots [8]string
}

func (h *host) free() int {
	n := 0
	for _, s := range h.slots {
		if s == "" {
			n++
		}
	}
	return n
}

// API is the fake backend. Mount it where the real API would be proxied.
type API struct {
	hosts     []*host
	mu        sync.Mutex
	balance   float64 // cents
	balanceAt time.Time
	offers    []offer
	vms       []*vm
	metal     []*server
	keys      []sshKey
	nextPort  int64
	nextIP    int
}

func New() *API {
	cpu := func(cores int64) map[string]any {
		return map[string]any{"count": 1, "manufacturer": "Intel", "model": "Xeon Platinum 8470", "cores": cores, "frequency": 2000000000}
	}
	mk := func(n, cores int64, qty int64) offer {
		return offer{
			Quantity: qty, MinimumReservationMinutes: 30, OnDemandPrice: 299 * n,
			Specs: specs{CPUCores: cores, RAMCapacity: 224 * gib * n, DiskCapacity: 12 * tb,
				GPUs: []gpu{{Count: n, Manufacturer: "AMD", Model: "MI300X"}}, CPUs: cpu(cores)},
		}
	}
	others := func(name string, taken ...int) *host {
		h := &host{name: name}
		for _, i := range taken {
			h.slots[i] = "-"
		}
		return h
	}
	return &API{
		// Other customers hold most of one server. Machines go where the app's preview says they will: next
		// to your others when there is room, else onto a free server.
		hosts:   []*host{others("enc1-host-07"), others("enc1-host-12", 0, 1, 2, 3, 4, 5), others("enc1-host-15")},
		balance: 25000, balanceAt: time.Now(),
		offers:   []offer{mk(1, 13, 6), mk(2, 26, 3), mk(4, 52, 2)},
		nextPort: 22101, nextIP: 40,
	}
}

// tick charges the balance for running machines since the last call. Caller holds mu.
func (a *API) tick() {
	now := time.Now()
	rate := a.rate()
	a.balance -= rate * now.Sub(a.balanceAt).Hours()
	a.balanceAt = now
	for _, v := range a.vms {
		if v.Status != "ready" && now.After(v.readyAt) {
			v.Status = "ready"
		}
		if !v.runningAt.IsZero() && now.After(v.runningAt) {
			v.powered, v.runningAt = true, time.Time{}
		}
	}
}

// rate is the hourly cost of everything assigned, in cents. Billing runs while a VM is assigned,
// powered or not, as with the real service's per-minute billing of reservations.
func (a *API) rate() float64 {
	r := 0.0
	for _, v := range a.vms {
		r += float64(v.price)
	}
	for _, s := range a.metal {
		r += float64(s.price)
	}
	return r
}

func id(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(code)
	_, _ = io.WriteString(w, msg)
}

// ServeHTTP handles paths of the form /api/... exactly like the real API.
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tick()
	time.Sleep(120 * time.Millisecond) // a little network feel, so loading states are visible

	p := strings.Trim(strings.TrimPrefix(r.URL.EscapedPath(), "/api"), "/")
	parts := strings.Split(p, "/")
	for i := range parts {
		parts[i], _ = url.PathUnescape(parts[i])
	}
	m := r.Method
	switch {
	case p == "user" && m == "GET":
		writeJSON(w, 200, map[string]any{
			"user":  map[string]any{"name": "Demo User", "email": "demo@example.com", "created": "2026-01-24T15:00:00Z", "email_auth_enabled": false},
			"teams": []any{a.teamJSON()},
		})
	case p == "teams" && m == "GET":
		writeJSON(w, 200, []any{a.teamJSON()})
	case p == "user/ssh_keys" && m == "GET":
		writeJSON(w, 200, a.keyList())
	case p == "user/ssh_keys" && m == "POST":
		a.addKey(w, r)
	case len(parts) == 3 && parts[0] == "user" && parts[1] == "ssh_keys" && m == "DELETE":
		for i, k := range a.keys {
			if k.Fingerprint == parts[2] {
				a.keys = append(a.keys[:i], a.keys[i+1:]...)
				w.WriteHeader(204)
				return
			}
		}
		fail(w, 404, "SSH key not found")
	case len(parts) >= 2 && parts[0] == "teams":
		if parts[1] != team {
			fail(w, 404, "team not found")
			return
		}
		a.teamRoute(w, r, parts[2:])
	default:
		fail(w, 404, "not found in demo mode")
	}
}

func (a *API) teamJSON() map[string]any {
	roles := []string{"owner", "purchaser", "operator", "user"}
	return map[string]any{"handle": team, "name": "Demo Lab", "description": "Sample data, nothing here is billed",
		"maximum_virtual_machines": 4, "maximum_bare_metal_servers": 1, "roles": roles, "effective_roles": roles, "invitation": false}
}

func (a *API) keyList() []sshKey {
	out := make([]sshKey, len(a.keys))
	copy(out, a.keys)
	return out
}

func (a *API) addKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AuthorizedKey string `json:"authorized_key"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req) != nil {
		fail(w, 400, "body must be JSON with authorized_key")
		return
	}
	f := strings.Fields(req.AuthorizedKey)
	if len(f) < 2 || !strings.HasPrefix(f[0], "ssh-") && !strings.HasPrefix(f[0], "ecdsa-") {
		fail(w, 422, "authorized_key must look like: ssh-ed25519 AAAA... comment")
		return
	}
	blob, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil {
		fail(w, 422, "the key data is not valid base64")
		return
	}
	sum := sha256.Sum256(blob)
	fp := "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "=")
	for _, k := range a.keys {
		if k.Fingerprint == fp {
			fail(w, 409, "key already registered")
			return
		}
	}
	k := sshKey{Type: f[0], PublicKey: f[1], Fingerprint: fp, Comment: strings.Join(f[2:], " ")}
	a.keys = append(a.keys, k)
	writeJSON(w, 200, k)
}

func (a *API) teamRoute(w http.ResponseWriter, r *http.Request, rest []string) {
	m := r.Method
	switch {
	case len(rest) == 1 && rest[0] == "balance" && m == "GET":
		rate := a.rate()
		out := map[string]any{"available_balance": int64(a.balance), "hourly_rate": rate,
			"virtual_machine_count": len(a.vms), "bare_metal_server_count": len(a.metal), "active_stripe_products": []any{},
			"minimum_balance": 1000}
		if rate > 0 {
			out["estimated_runout_time"] = time.Now().Add(time.Duration(a.balance / rate * float64(time.Hour))).UTC().Format(time.RFC3339)
		}
		writeJSON(w, 200, out)
	case len(rest) == 1 && rest[0] == "purchase-credits" && m == "POST":
		var req struct {
			Cents int64 `json:"cents"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req) != nil || req.Cents < 2000 {
			fail(w, 400, "cents must be at least 2000 ($20.00)")
			return
		}
		a.balance += float64(req.Cents) // demo: no checkout, credits land at once
		writeJSON(w, 200, map[string]any{"checkout_url": "", "expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "demo_credited": true})
	case len(rest) == 2 && rest[0] == "virtual_machines" && rest[1] == "available" && m == "GET":
		writeJSON(w, 200, a.offers)
	case len(rest) == 2 && rest[0] == "bare_metal" && rest[1] == "available" && m == "GET":
		free := 0
		for _, h := range a.hosts {
			if h.free() == 8 {
				free++
			}
		}
		writeJSON(w, 200, []map[string]any{{"Quantity": free, "MinimumReservationMinutes": int(metalMinimum.Minutes()), "OnDemandPrice": 339 * 8, "Specs": metalSpecs()}})
	case len(rest) == 1 && rest[0] == "bare_metal" && m == "GET":
		list := append([]*server{}, a.metal...) // [] when empty, as the real API answers
		writeJSON(w, 200, list)
	case len(rest) == 1 && rest[0] == "bare_metal" && m == "POST":
		a.reserve(w)
	case len(rest) >= 2 && rest[0] == "bare_metal":
		for _, s := range a.metal {
			if s.Name == rest[1] {
				a.metalRoute(w, r, s, rest[2:])
				return
			}
		}
		fail(w, 404, "bare metal server not found")
	case len(rest) == 1 && rest[0] == "virtual_machines" && m == "GET":
		list := make([]*vm, len(a.vms))
		copy(list, a.vms)
		sort.Slice(list, func(i, j int) bool { return list[i].created.Before(list[j].created) })
		writeJSON(w, 200, list)
	case len(rest) == 1 && rest[0] == "virtual_machines" && m == "POST":
		a.provision(w, r)
	case len(rest) >= 2 && rest[0] == "virtual_machines":
		v := a.find(rest[1])
		if v == nil {
			fail(w, 404, "virtual machine not found")
			return
		}
		a.vmRoute(w, r, v, rest[2:])
	default:
		fail(w, 404, "not found in demo mode")
	}
}

func (a *API) find(name string) *vm {
	for _, v := range a.vms {
		if v.Name == name {
			return v
		}
	}
	return nil
}

func (a *API) provision(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GPUs        []gpu  `json:"gpus"`
		UserDataURL string `json:"user_data_url"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req) != nil || len(req.GPUs) == 0 || req.GPUs[0].Count < 1 {
		fail(w, 400, "request must name the GPUs, e.g. {\"gpus\":[{\"count\":1,\"model\":\"MI300X\"}]}")
		return
	}
	if len(a.vms) >= 4 {
		fail(w, 401, "Maximum VMs already provisioned for this team")
		return
	}
	if len(a.keys) == 0 {
		fail(w, 428, "Team has no accepted user-role member with an SSH key")
		return
	}
	var o *offer
	for i := range a.offers {
		g := a.offers[i].Specs.GPUs[0]
		if g.Count == req.GPUs[0].Count && (req.GPUs[0].Model == "" || strings.EqualFold(g.Model, req.GPUs[0].Model)) {
			o = &a.offers[i]
		}
	}
	if o == nil || o.Quantity == 0 {
		fail(w, 404, "No available virtual machine matching requested specifications")
		return
	}
	minCharge := float64(o.OnDemandPrice) * float64(o.MinimumReservationMinutes) / 60
	if a.balance-minCharge < 1000 {
		fail(w, 402, "Insufficient balance to provision virtual machine")
		return
	}
	// A server already running this team's machines while it has room, as a scheduler packs them;
	// otherwise best fit: the server with the fewest free GPUs that still has room.
	need := int(req.GPUs[0].Count)
	var h *host
	for _, v := range a.vms {
		if v.host != nil && v.host.free() >= need {
			h = v.host
			break
		}
	}
	if h == nil {
		for _, c := range a.hosts {
			if c.free() == 8 {
				h = c
				break
			}
		}
	}
	if h == nil {
		for _, c := range a.hosts {
			if c.free() >= need && (h == nil || c.free() < h.free()) {
				h = c
			}
		}
	}
	if h == nil {
		fail(w, 404, "No available virtual machine matching requested specifications")
		return
	}
	o.Quantity--
	now := time.Now()
	a.nextIP++
	a.nextPort++
	v := &vm{
		Name: fmt.Sprintf("enc1-%s", id(3)), DeploymentID: uuid(), IPAddress: fmt.Sprintf("10.20.%d.%d", 1+a.nextIP/250, a.nextIP%250),
		Status: "ready", SSHAccess: &sshAccess{IPAddress: "198.51.100.17", Port: a.nextPort},
		specs: o.Specs, price: o.OnDemandPrice, host: h, created: now, readyAt: now, runningAt: now.Add(4 * time.Second),
	}
	for i := range h.slots {
		if h.slots[i] == "" && len(v.slots) < int(req.GPUs[0].Count) {
			h.slots[i] = v.Name
			v.slots = append(v.slots, i)
		}
	}
	if req.UserDataURL != "" {
		v.Status = "rebuild_queued"
		v.readyAt = now.Add(25 * time.Second)
		v.runningAt = v.readyAt
	}
	a.vms = append(a.vms, v)
	writeJSON(w, 200, v)
}

func (a *API) vmRoute(w http.ResponseWriter, r *http.Request, v *vm, rest []string) {
	m := r.Method
	now := time.Now()
	action := ""
	if len(rest) == 1 {
		action = rest[0]
	}
	switch {
	case action == "" && m == "GET":
		writeJSON(w, 200, v)
	case action == "" && m == "PATCH":
		var req struct {
			Description string `json:"description"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req) != nil {
			fail(w, 400, "body must be JSON with description")
			return
		}
		v.Description = req.Description
		w.WriteHeader(204)
	case action == "" && m == "DELETE":
		minimum := 30 * time.Minute
		if now.Sub(v.created) < minimum && r.URL.Query().Get("force") != "true" {
			left := minimum - now.Sub(v.created)
			fail(w, 400, fmt.Sprintf("minimum reservation time not met (%d min left); pass force=true to delete anyway, the minimum charge is not refunded", int(left.Minutes())+1))
			return
		}
		if held := now.Sub(v.created); held < minimum {
			// Released early with force: the rest of the minimum reservation is still charged.
			a.balance -= float64(v.price) * (minimum - held).Hours()
		}
		for i, x := range a.vms {
			if x == v {
				a.vms = append(a.vms[:i], a.vms[i+1:]...)
			}
		}
		if v.host != nil {
			for _, i := range v.slots {
				v.host.slots[i] = ""
			}
		}
		for i := range a.offers {
			if a.offers[i].Specs.GPUs[0].Count == v.GPUs[0].Count {
				a.offers[i].Quantity++
			}
		}
		w.WriteHeader(204)
	case action == "state" && m == "GET":
		st := "shut off"
		if v.powered {
			st = "running"
		} else if !v.runningAt.IsZero() {
			st = "starting"
		}
		hostName := ""
		if v.host != nil {
			hostName = v.host.name
		}
		writeJSON(w, 200, map[string]any{"state": st, "host": hostName})
	case m == "POST" && (action == "start" || action == "reboot" || action == "hard-reset"):
		v.powered, v.runningAt = false, now.Add(3*time.Second)
		w.WriteHeader(204)
	case m == "POST" && (action == "stop" || action == "shutdown"):
		v.powered, v.runningAt = false, time.Time{}
		w.WriteHeader(204)
	case m == "POST" && action == "rebuild":
		v.Status, v.powered = "rebuilding", false
		v.readyAt = now.Add(20 * time.Second)
		v.runningAt = v.readyAt
		w.WriteHeader(202)
	default:
		fail(w, 404, "not found in demo mode")
	}
}

// reserve takes a whole free server, as the real service does for a bare-metal reservation.
func (a *API) reserve(w http.ResponseWriter) {
	var h *host
	for _, c := range a.hosts {
		if c.free() == 8 {
			h = c
			break
		}
	}
	if h == nil {
		fail(w, 404, "no bare metal server of that type is available")
		return
	}
	price := int64(339 * 8)
	if a.balance-1000 < float64(price)*metalMinimum.Hours() {
		fail(w, 402, "insufficient balance for the minimum reservation")
		return
	}
	now := time.Now()
	a.nextPort++
	s := &server{
		Name: h.name, DeploymentID: uuid(), IPAddress: fmt.Sprintf("10.20.9.%d", 10+len(a.metal)),
		Manufacturer: "Dell", Model: "PowerEdge XE9680", SSHAccess: &sshAccess{IPAddress: "198.51.100.18", Port: a.nextPort},
		host: h, price: price, created: now, installAt: now,
	}
	for i := range h.slots {
		h.slots[i] = s.Name
	}
	a.metal = append(a.metal, s)
	writeJSON(w, 201, s.details(now))
}

func (s *server) details(now time.Time) map[string]any {
	out := metalSpecs()
	out["name"], out["deployment_id"], out["description"], out["ip_address"] = s.Name, s.DeploymentID, s.Description, s.IPAddress
	out["manufacturer"], out["model"], out["ssh_access"], out["specs"] = s.Manufacturer, s.Model, s.SSHAccess, metalSpecs()
	out["os_status"] = map[string]any{"os_install_status": s.stage(now), "last_imaging_update": now.UTC().Format(time.RFC3339)}
	return out
}

func (a *API) metalRoute(w http.ResponseWriter, r *http.Request, s *server, rest []string) {
	m := r.Method
	now := time.Now()
	action := strings.Join(rest, "/")
	switch {
	case action == "" && m == "GET":
		writeJSON(w, 200, s.details(now))
	case action == "" && m == "PATCH":
		var req struct {
			Description string `json:"description"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&req) != nil {
			fail(w, 400, "body must be JSON with description")
			return
		}
		s.Description = req.Description
		w.WriteHeader(204)
	case action == "" && m == "DELETE":
		held := now.Sub(s.created)
		if held < metalMinimum && r.URL.Query().Get("force") != "true" {
			fail(w, 400, fmt.Sprintf("minimum reservation time not met (%d min left); pass force=true to release anyway, the minimum charge is not refunded", int((metalMinimum-held).Minutes())+1))
			return
		}
		if held < metalMinimum {
			a.balance -= float64(s.price) * (metalMinimum - held).Hours()
		}
		for i, x := range a.metal {
			if x == s {
				a.metal = append(a.metal[:i], a.metal[i+1:]...)
			}
		}
		for i := range s.host.slots {
			s.host.slots[i] = ""
		}
		w.WriteHeader(204)
	case action == "power" && m == "GET":
		st := "On"
		if s.off {
			st = "Off"
		}
		writeJSON(w, 200, map[string]any{"state": st})
	case strings.HasPrefix(action, "power/") && m == "POST":
		s.off = action == "power/graceful_shutdown" || action == "power/force_shutdown"
		w.WriteHeader(204)
	case action == "reinstall" && m == "POST":
		s.installAt, s.off = now, false
		w.WriteHeader(202)
	default:
		fail(w, 404, "not found in demo mode")
	}
}

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
