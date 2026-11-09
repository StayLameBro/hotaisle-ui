// Package state remembers what the API doesn't tell us about machines launched from this app:
// when they were launched, with which image, at what price, and when to end them automatically,
// plus a short history of machines that have ended (how long they ran and about what they cost).
//
// It is stored next to the CLI config (~/.hotaisle/ui-state.json, mode 0600). Demo sessions use a
// separate in-memory store so sample machines never touch the file.
package state

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Machine is what we know about one machine.
type Machine struct {
	Team       string     `json:"team"`
	Name       string     `json:"name"`
	LaunchedAt *time.Time `json:"launched_at,omitempty"`
	Image      string     `json:"image,omitempty"`
	PriceCents int64      `json:"price_cents,omitempty"`
	ReleaseAt  *time.Time `json:"release_at,omitempty"`
	LastError  string     `json:"last_error,omitempty"`
	// GPUs is the size as people say it ("4× MI300X"), kept for the history when auto-end ends it.
	GPUs string `json:"gpus,omitempty"`
	// Metal marks a bare-metal server, which is ended through its own endpoint.
	Metal bool `json:"metal,omitempty"`
}

// Ended is one machine that has ended, as the app saw it.
type Ended struct {
	Team    string    `json:"team"`
	Name    string    `json:"name"`
	GPUs    string    `json:"gpus"`
	RanMS   int64     `json:"ran_ms,omitempty"`
	Cents   float64   `json:"cents,omitempty"`
	Minimum bool      `json:"minimum_applied,omitempty"`
	EndedAt time.Time `json:"ended_at"`

	// What the run was, for looking back at it.
	StartedAt  *time.Time `json:"started_at,omitempty"`
	Server     string     `json:"server,omitempty"`
	Image      string     `json:"image,omitempty"`
	PriceCents int64      `json:"price_cents,omitempty"`
	Note       string     `json:"note,omitempty"`
	Metal      bool       `json:"metal,omitempty"`
	Cores      int64      `json:"cpu_cores,omitempty"`
	RAM        int64      `json:"ram_capacity,omitempty"`
	Disk       int64      `json:"disk_capacity,omitempty"`
	By         string     `json:"ended_by,omitempty"` // "you" or "auto-end"
}

// HistoryLimit is how many ended machines are kept per team.
const HistoryLimit = 20

type Store struct {
	path    string // "" = memory only
	mu      sync.Mutex
	m       map[string]*Machine // key: team/name
	history []Ended             // newest first
}

// file is the on-disk shape. Older versions wrote a bare list of machines, which Open still reads.
type file struct {
	Machines []*Machine `json:"machines"`
	History  []Ended    `json:"history,omitempty"`
}

func key(team, name string) string { return team + "/" + name }

// Open loads the store at path; a missing file is an empty store. path "" keeps it in memory.
func Open(path string) (*Store, error) {
	s := &Store{path: path, m: map[string]*Machine{}}
	if path == "" {
		return s, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var f file
	if len(b) > 0 {
		if err := json.Unmarshal(b, &f); err != nil {
			if err := json.Unmarshal(b, &f.Machines); err != nil {
				return nil, err
			}
		}
	}
	s.history = f.History
	for _, m := range f.Machines {
		if m != nil && m.Name != "" {
			s.m[key(m.Team, m.Name)] = m
		}
	}
	return s, nil
}

func (s *Store) saveLocked() error {
	if s.path == "" {
		return nil
	}
	list := make([]*Machine, 0, len(s.m))
	for _, m := range s.m {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool { return key(list[i].Team, list[i].Name) < key(list[j].Team, list[j].Name) })
	b, err := json.MarshalIndent(file{Machines: list, History: s.history}, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".ui-state-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

// List returns the machines of one team.
func (s *Store) List(team string) []Machine {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Machine{}
	for _, m := range s.m {
		if m.Team == team {
			out = append(out, *m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Update merges fields into the record for team/name, creating it if needed.
func (s *Store) Update(team, name string, fn func(m *Machine)) (Machine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.m[key(team, name)]
	if m == nil {
		m = &Machine{Team: team, Name: name}
		s.m[key(team, name)] = m
	}
	fn(m)
	return *m, s.saveLocked()
}

// PruneGrace keeps records of machines launched this recently, whatever the caller says is alive.
const PruneGrace = 5 * time.Minute

// Prune forgets machines of a team that no longer exist.
func (s *Store) Prune(team string, alive []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := map[string]bool{}
	for _, n := range alive {
		keep[n] = true
	}
	changed := false
	for k, m := range s.m {
		// A list fetched just before a launch can arrive just after it; never forget a fresh launch over that.
		if m.LaunchedAt != nil && time.Since(*m.LaunchedAt) < PruneGrace {
			continue
		}
		if m.Team == team && !keep[m.Name] {
			delete(s.m, k)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.saveLocked()
}

// Remove forgets one machine.
func (s *Store) Remove(team, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, key(team, name))
	return s.saveLocked()
}

// Due returns machines whose release time has passed.
func (s *Store) Due(now time.Time) []Machine {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Machine
	for _, m := range s.m {
		if m.ReleaseAt != nil && !m.ReleaseAt.After(now) {
			out = append(out, *m)
		}
	}
	return out
}

// Pending says whether any machine has an auto-end timer set.
func (s *Store) Pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.m {
		if m.ReleaseAt != nil {
			return true
		}
	}
	return false
}

// AddEnded records a machine that has ended, newest first, keeping HistoryLimit per team.
// Recording the same machine twice replaces the earlier entry.
func (s *Store) AddEnded(e Ended) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Ended{e}
	kept := 0
	for _, h := range s.history {
		if h.Team == e.Team && h.Name == e.Name {
			continue
		}
		if h.Team == e.Team {
			if kept >= HistoryLimit-1 {
				continue
			}
			kept++
		}
		out = append(out, h)
	}
	s.history = out
	return s.saveLocked()
}

// History returns the ended machines of one team, newest first.
func (s *Store) History(team string) []Ended {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Ended{}
	for _, h := range s.history {
		if h.Team == team {
			out = append(out, h)
		}
	}
	return out
}
