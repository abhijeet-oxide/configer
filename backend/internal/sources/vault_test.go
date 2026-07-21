package sources

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func mockClient(status int, body string, capture *http.Request) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if capture != nil {
			*capture = *r
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}
}

func TestVaultFetchMasksAndReferences(t *testing.T) {
	var seen http.Request
	body := `{"data":{"data":{"db_password":"s3cr3t","api_key":"abc"},"metadata":{"version":3}}}`
	v := vaultSource{http: mockClient(http.StatusOK, body, &seen)}
	cfg := plugin.SourceConfig{
		Values: map[string]string{"address": "https://vault.example", "mount": "secret", "path": "telco/prod"},
		Secret: "tok",
	}

	kvs, err := v.Fetch(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(kvs) != 2 {
		t.Fatalf("want 2 secret fields, got %d", len(kvs))
	}
	for _, kv := range kvs {
		if !kv.Secret {
			t.Errorf("%s should be marked secret", kv.Key)
		}
		if kv.Value == "s3cr3t" || kv.Value == "abc" {
			t.Errorf("plaintext secret leaked in Value for %s", kv.Key)
		}
		if !strings.HasPrefix(kv.Ref, "${vault:secret/telco/prod#") {
			t.Errorf("unexpected reference for %s: %q", kv.Key, kv.Ref)
		}
	}
	// The KV v2 data path and token header must be used.
	if !strings.Contains(seen.URL.Path, "/v1/secret/data/telco/prod") {
		t.Errorf("unexpected request path: %s", seen.URL.Path)
	}
	if seen.Header.Get("X-Vault-Token") != "tok" {
		t.Errorf("token header not set")
	}
}

func TestVaultDeniedAccess(t *testing.T) {
	v := vaultSource{http: mockClient(http.StatusForbidden, "", nil)}
	cfg := plugin.SourceConfig{Values: map[string]string{"address": "https://v", "mount": "secret", "path": "p"}}
	if _, err := v.Fetch(context.Background(), cfg); err == nil {
		t.Fatal("expected an access-denied error")
	}
}
