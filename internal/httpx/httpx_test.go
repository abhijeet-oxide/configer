package httpx

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// The shared transport must carry a Proxy function so outbound calls can be
// routed through a configured proxy at all.
func TestTransportHasProxy(t *testing.T) {
	if Transport().Proxy == nil {
		t.Fatal("shared transport has no Proxy: outbound calls would ignore HTTP(S)_PROXY")
	}
}

// A client built here routes an HTTP request through the proxy named by the
// environment. This exercises the real env-proxy path end to end (the first
// ProxyFromEnvironment call in this test binary reads the vars set below).
func TestClientHonorsProxyEnv(t *testing.T) {
	var hits int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer proxy.Close()

	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")

	// A host that never resolves: it only succeeds if the proxy handles it.
	resp, err := Client(5 * time.Second).Get("http://configer.invalid/")
	if err != nil {
		t.Fatalf("request errored instead of going through the proxy: %v", err)
	}
	_ = resp.Body.Close()

	if atomic.LoadInt32(&hits) == 0 {
		t.Fatal("request did not go through the configured proxy")
	}
}
