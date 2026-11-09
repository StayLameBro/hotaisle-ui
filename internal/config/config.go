// Package config reads and writes the Hot Aisle CLI's configuration file, so a user who has run
// `hotaisle login` is signed in here too, and a token saved here works in the CLI.
//
// Resolution matches the CLI: --config-file, then HOTAISLE_CONFIG_FILE, then ~/.hotaisle/config.json.
// HOTAISLE_API_TOKEN and HOTAISLE_DEFAULT_TEAM override the saved values without being written.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Config is what this app needs from the shared file.
type Config struct {
	Path        string // resolved file path
	APIToken    string
	DefaultTeam string
	TokenSource string // "env", "file" or ""
	TeamSource  string
}

func resolvePath(flagPath string) (string, error) {
	p := flagPath
	if p == "" {
		p = os.Getenv("HOTAISLE_CONFIG_FILE")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if p == "" {
		return filepath.Join(home, ".hotaisle", "config.json"), nil
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return filepath.Abs(p)
}

// Load reads the config file (a missing file is fine) and applies the environment overrides.
func Load(flagPath string) (*Config, error) {
	path, err := resolvePath(flagPath)
	if err != nil {
		return nil, err
	}
	c := &Config{Path: path}
	raw, err := readRaw(path)
	if err != nil {
		return nil, err
	}
	if s, ok := raw["api_token"].(string); ok && s != "" {
		c.APIToken, c.TokenSource = s, "file"
	}
	if s, ok := raw["default_team"].(string); ok && s != "" {
		c.DefaultTeam, c.TeamSource = s, "file"
	}
	if s := os.Getenv("HOTAISLE_API_TOKEN"); s != "" {
		c.APIToken, c.TokenSource = s, "env"
	}
	if s := os.Getenv("HOTAISLE_DEFAULT_TEAM"); s != "" {
		c.DefaultTeam, c.TeamSource = s, "env"
	}
	return c, nil
}

func readRaw(path string) (map[string]any, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	raw := map[string]any{}
	if len(strings.TrimSpace(string(b))) == 0 {
		return raw, nil
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return raw, nil
}

// Save writes the token and team into the file, keeping any other keys the CLI stores there.
// The directory is created 0700 and the file written 0600, through a temp file and rename.
func (c *Config) Save(token, team *string) error {
	raw, err := readRaw(c.Path)
	if err != nil {
		return err
	}
	if token != nil {
		raw["api_token"] = *token
		c.APIToken, c.TokenSource = *token, "file"
	}
	if team != nil {
		raw["default_team"] = *team
		c.DefaultTeam, c.TeamSource = *team, "file"
	}
	if _, ok := raw["api_token"]; !ok {
		raw["api_token"] = ""
	}
	if _, ok := raw["default_team"]; !ok {
		raw["default_team"] = ""
	}
	b, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(c.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".config-*.json")
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
	return os.Rename(tmp.Name(), c.Path)
}
