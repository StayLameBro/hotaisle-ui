package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveKeepsOtherKeysAndIsPrivate(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".hotaisle")
	os.MkdirAll(dir, 0o700)
	p := filepath.Join(dir, "config.json")
	os.WriteFile(p, []byte(`{"log_level":"debug","api_token":"old","default_team":"a"}`), 0o600)
	t.Setenv("HOTAISLE_API_TOKEN", "")
	t.Setenv("HOTAISLE_DEFAULT_TEAM", "")

	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.APIToken != "old" || c.DefaultTeam != "a" || c.TokenSource != "file" {
		t.Fatalf("loaded %+v", c)
	}
	tok, team := "new", "b"
	if err := c.Save(&tok, &team); err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	b, _ := os.ReadFile(p)
	json.Unmarshal(b, &raw)
	if raw["log_level"] != "debug" || raw["api_token"] != "new" || raw["default_team"] != "b" {
		t.Fatalf("saved %s", b)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
}

func TestEnvOverridesWithoutWriting(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("HOTAISLE_API_TOKEN", "from-env")
	t.Setenv("HOTAISLE_DEFAULT_TEAM", "env-team")
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.APIToken != "from-env" || c.TokenSource != "env" || c.DefaultTeam != "env-team" {
		t.Fatalf("loaded %+v", c)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("Load must not create the file")
	}
}

func TestMissingFileIsFine(t *testing.T) {
	t.Setenv("HOTAISLE_API_TOKEN", "")
	t.Setenv("HOTAISLE_DEFAULT_TEAM", "")
	c, err := Load(filepath.Join(t.TempDir(), "nope", "config.json"))
	if err != nil || c.APIToken != "" {
		t.Fatalf("%+v %v", c, err)
	}
}
