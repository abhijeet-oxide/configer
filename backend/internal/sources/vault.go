package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// vaultSource reads secrets from a HashiCorp Vault KV v2 engine. It is
// EXPERIMENTAL: secret values are never returned as plaintext and never
// committed. Each secret field maps to a reference string
// ("${vault:mount/path#key}") that is written into the bound repository file in
// place of the value; the real secret is resolved at deploy time by the
// platform's secret tooling. Exercising it end to end needs a live Vault; the
// parsing and reference logic are unit-tested against a mocked HTTP transport.
type vaultSource struct {
	http *http.Client
}

func newVaultSource() vaultSource {
	return vaultSource{http: &http.Client{Timeout: 30 * time.Second}}
}

func (v vaultSource) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID:          "vault",
		Name:        "HashiCorp Vault",
		Version:     "0.1.0",
		Kind:        plugin.KindSource,
		Description: "Map parameters to secrets in a HashiCorp Vault KV v2 engine. Values are written back as references, never plaintext. Experimental.",
		Icon:        "vault",
		Color:       "gold",
		Category:    "Secret store",
	}
}

func (v vaultSource) Fields() []plugin.SourceField {
	return []plugin.SourceField{
		{Key: "address", Label: "Vault address", Type: "text", Required: true,
			Help: "Base URL of the Vault server (e.g. https://vault.internal:8200)."},
		{Key: "mount", Label: "KV mount", Type: "text", Required: true,
			Help: "The KV v2 secrets engine mount (e.g. secret)."},
		{Key: "path", Label: "Secret path", Type: "path", Required: true,
			Help: "Path of the secret within the mount (e.g. telco/prod/db)."},
		{Key: "token", Label: "Token", Type: "password", Required: false, Secret: true,
			Help: "Resolved from the VAULT_TOKEN environment variable on the server; never stored."},
	}
}

func (v vaultSource) client() *http.Client {
	if v.http != nil {
		return v.http
	}
	return http.DefaultClient
}

// Fetch reads the secret's fields and returns one masked key/value per field,
// each carrying the reference that is written back instead of the plaintext.
func (v vaultSource) Fetch(ctx context.Context, cfg plugin.SourceConfig) ([]plugin.SourceKV, error) {
	address, mount, secretPath, err := vaultTarget(cfg)
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(address, "/") + "/v1/" + mount + "/data/" + secretPath
	var resp struct {
		Data struct {
			Data     map[string]any `json:"data"`
			Metadata struct {
				Version int `json:"version"`
			} `json:"metadata"`
		} `json:"data"`
	}
	if err := v.get(ctx, url, cfg.Secret, &resp); err != nil {
		return nil, err
	}
	out := make([]plugin.SourceKV, 0, len(resp.Data.Data))
	for k := range resp.Data.Data {
		out = append(out, plugin.SourceKV{
			Key:    k,
			Value:  maskSecret,
			Type:   model.TypeString,
			Secret: true,
			Ref:    vaultRef(mount, secretPath, k),
		})
	}
	return out, nil
}

// Browse lists the immediate secret keys/subpaths under path via the KV v2
// metadata LIST API.
func (v vaultSource) Browse(ctx context.Context, cfg plugin.SourceConfig, browsePath string) ([]plugin.BrowseEntry, error) {
	address := strings.TrimSpace(cfg.Get("address"))
	mount := strings.TrimSpace(cfg.Get("mount"))
	if address == "" || mount == "" {
		return nil, fmt.Errorf("a Vault address and mount are required")
	}
	listPath := strings.Trim(browsePath, "/")
	url := strings.TrimRight(address, "/") + "/v1/" + mount + "/metadata/" + listPath + "?list=true"
	var resp struct {
		Data struct {
			Keys []string `json:"keys"`
		} `json:"data"`
	}
	if err := v.get(ctx, url, cfg.Secret, &resp); err != nil {
		return nil, err
	}
	var out []plugin.BrowseEntry
	for _, k := range resp.Data.Keys {
		full := strings.Trim(listPath+"/"+k, "/")
		if strings.HasSuffix(k, "/") {
			out = append(out, plugin.BrowseEntry{Name: strings.TrimSuffix(k, "/"), Path: strings.TrimSuffix(full, "/"), IsDir: true})
			continue
		}
		out = append(out, plugin.BrowseEntry{Name: k, Path: full})
	}
	return out, nil
}

const maskSecret = "********"

func vaultTarget(cfg plugin.SourceConfig) (address, mount, secretPath string, err error) {
	address = strings.TrimSpace(cfg.Get("address"))
	mount = strings.TrimSpace(cfg.Get("mount"))
	secretPath = strings.Trim(strings.TrimSpace(cfg.Get("path")), "/")
	if address == "" || mount == "" || secretPath == "" {
		return "", "", "", fmt.Errorf("a Vault address, mount and secret path are required")
	}
	return address, mount, secretPath, nil
}

// vaultRef is the reference written into a repository file for a Vault secret.
func vaultRef(mount, secretPath, key string) string {
	return fmt.Sprintf("${vault:%s/%s#%s}", mount, secretPath, key)
}

func (v vaultSource) get(ctx context.Context, url, token string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("X-Vault-Token", token)
	}
	resp, err := v.client().Do(req)
	if err != nil {
		return fmt.Errorf("reach Vault: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("Vault denied access (check VAULT_TOKEN and policy)")
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("Vault returned status %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
