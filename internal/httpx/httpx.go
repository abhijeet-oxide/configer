// Package httpx builds the HTTP clients Configer uses for outbound calls to
// GitHub - OAuth sign-in, REST browsing, the no-clone Git data API, and PR
// creation. Every client is proxy-aware: it honors the standard HTTP_PROXY,
// HTTPS_PROXY and NO_PROXY environment variables (and their lowercase forms)
// through http.ProxyFromEnvironment. A deployment behind a corporate or agent
// proxy therefore routes GitHub traffic through it, HTTP and HTTPS URLs each use
// their configured proxy, and NO_PROXY still lets named hosts connect directly.
//
// Git subprocess calls (clone/fetch/push) inherit this same environment and are
// handled by git/libcurl, so they respect the same proxy settings without any
// code here.
package httpx

import (
	"net"
	"net/http"
	"time"
)

// sharedTransport is proxy-aware and reused across every client so connections
// pool. Using http.ProxyFromEnvironment (rather than a nil transport that only
// implicitly falls back to it) makes the proxy behavior explicit and immune to a
// caller later swapping in a transport that forgets it. Proxy selection and the
// NO_PROXY exclusions are evaluated per request host.
var sharedTransport = &http.Transport{
	Proxy: http.ProxyFromEnvironment,
	DialContext: (&net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	ForceAttemptHTTP2:     true,
	MaxIdleConns:          100,
	MaxIdleConnsPerHost:   10,
	IdleConnTimeout:       90 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
}

// Client returns an HTTP client with the shared proxy-aware transport and the
// given overall timeout (0 means no timeout).
func Client(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: sharedTransport}
}

// Transport exposes the shared proxy-aware transport for callers that need to
// build their own client or wrap it (e.g. adding an auth round-tripper).
func Transport() *http.Transport { return sharedTransport }
