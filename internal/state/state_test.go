package state

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPersistDueAndPrune(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ui-state.json")
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	past, future, old := now.Add(-time.Minute), now.Add(time.Hour), now.Add(-time.Hour)
	s.Update("t", "a", func(m *Machine) { m.LaunchedAt = &old; m.ReleaseAt = &past; m.PriceCents = 299 })
	s.Update("t", "b", func(m *Machine) { m.ReleaseAt = &future })
	s.Update("other", "c", func(m *Machine) {})

	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
	s2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := s2.List("t"); len(got) != 2 || got[0].PriceCents != 299 {
		t.Fatalf("reloaded %+v", got)
	}
	due := s2.Due(now)
	if len(due) != 1 || due[0].Name != "a" {
		t.Fatalf("due %+v", due)
	}
	s2.Prune("t", []string{"b"})
	if got := s2.List("t"); len(got) != 1 || got[0].Name != "b" {
		t.Fatalf("after prune %+v", got)
	}
	if got := s2.List("other"); len(got) != 1 {
		t.Fatal("prune touched another team")
	}
}

func TestMemoryStoreWritesNothing(t *testing.T) {
	s, _ := Open("")
	if _, err := s.Update("t", "a", func(m *Machine) {}); err != nil {
		t.Fatal(err)
	}
	if len(s.List("t")) != 1 {
		t.Fatal("memory store lost the record")
	}
}

func TestPruneKeepsFreshLaunches(t *testing.T) {
	s, _ := Open("")
	now := time.Now()
	s.Update("t", "just-launched", func(m *Machine) { m.LaunchedAt = &now })
	s.Update("t", "gone", func(m *Machine) {})
	// A stale machine list that predates the launch.
	s.Prune("t", nil)
	got := s.List("t")
	if len(got) != 1 || got[0].Name != "just-launched" {
		t.Fatalf("after prune %+v", got)
	}
}

func TestHistoryNewestFirstCappedAndReloaded(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ui-state.json")
	s, _ := Open(p)
	base := time.Now()
	for i := 0; i < HistoryLimit+5; i++ {
		if err := s.AddEnded(Ended{Team: "t", Name: fmt.Sprintf("m%d", i), EndedAt: base.Add(time.Duration(i) * time.Minute)}); err != nil {
			t.Fatal(err)
		}
	}
	s.AddEnded(Ended{Team: "other", Name: "x", EndedAt: base})
	s.AddEnded(Ended{Team: "t", Name: fmt.Sprintf("m%d", HistoryLimit+4), Cents: 150, EndedAt: base.Add(time.Hour)})
	s2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	h := s2.History("t")
	if len(h) != HistoryLimit || h[0].Name != fmt.Sprintf("m%d", HistoryLimit+4) || h[0].Cents != 150 {
		t.Fatalf("history %d first %+v", len(h), h[0])
	}
	if len(s2.History("other")) != 1 {
		t.Fatal("other team's history lost")
	}
}

func TestOpenReadsTheOldListFormat(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ui-state.json")
	os.WriteFile(p, []byte(`[{"team":"t","name":"a","price_cents":299}]`), 0o600)
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.List("t"); len(got) != 1 || got[0].PriceCents != 299 {
		t.Fatalf("old format: %+v", got)
	}
}
