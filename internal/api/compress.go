package api

// Response compression. The API's payloads are JSON matrices - a grid is one
// object per (parameter, instance) cell - so they are extremely repetitive and
// compress about 20x. Sending them raw made the largest single item on a page
// load the API response, not the application bundle: a 400-parameter x
// 20-instance grid is 1.4 MB uncompressed and 66 KB gzipped, and the UI refetches
// it after every edit.
//
// Only text payloads are compressed, only when the client asked, and only past a
// size where the CPU is worth it. Already-compressed bodies (a git pack, a font,
// an image) are left alone.

import (
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// gzipMinBytes is the response size below which compression is skipped: under
// roughly one network packet there is nothing to save, and the header overhead
// plus the CPU makes it a loss.
const gzipMinBytes = 1024

// gzipWriterPool reuses the compressor state (its window buffer is ~64 KiB) so a
// busy server does not allocate one per response.
var gzipWriterPool = sync.Pool{
	New: func() any { return gzip.NewWriter(nil) },
}

// compressibleType reports whether a Content-Type is worth compressing. Text
// formats are; anything already compressed (or opaque) is not.
func compressibleType(ct string) bool {
	ct = strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	switch {
	case ct == "application/json", ct == "application/xml", ct == "image/svg+xml",
		ct == "application/javascript", ct == "application/x-yaml", ct == "application/yaml":
		return true
	case strings.HasPrefix(ct, "text/"):
		return true
	case strings.HasSuffix(ct, "+json"), strings.HasSuffix(ct, "+xml"):
		return true
	}
	return false
}

// acceptsGzip reports whether the client offered gzip and did not explicitly
// refuse it (`gzip;q=0`).
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, p := range fields[1:] {
			if q := strings.TrimSpace(p); strings.HasPrefix(q, "q=") {
				if v, err := strconv.ParseFloat(q[2:], 64); err == nil && v == 0 {
					return false
				}
			}
		}
		return true
	}
	return false
}

// gzipResponseWriter buffers the first bytes of a response so the decision to
// compress can be made from the Content-Type the handler actually set and from
// the real body size - neither of which is known when the middleware runs. Once
// decided it either streams through the compressor or writes straight through;
// it never buffers a whole response.
type gzipResponseWriter struct {
	http.ResponseWriter
	req *http.Request

	decided bool
	gz      *gzip.Writer
	// head holds the bytes seen before the decision, so a response smaller than
	// gzipMinBytes can still be written out verbatim.
	head   []byte
	status int
}

func (w *gzipResponseWriter) WriteHeader(code int) {
	w.status = code
	// A 304 has no body, and a handler that already encoded its own body owns
	// the encoding: in both cases decide "no compression" now, before the
	// headers go out.
	if code == http.StatusNotModified || w.Header().Get("Content-Encoding") != "" {
		w.decided = true
		w.ResponseWriter.WriteHeader(code)
		return
	}
	// Hold the header until the first write, when the body size is known.
}

// decide commits to compressing (or not) now that `pending` bytes of body exist.
func (w *gzipResponseWriter) decide(pending int) {
	w.decided = true
	if w.status == 0 {
		w.status = http.StatusOK
	}
	h := w.Header()
	if !compressibleType(h.Get("Content-Type")) || pending < gzipMinBytes {
		w.ResponseWriter.WriteHeader(w.status)
		return
	}
	h.Set("Content-Encoding", "gzip")
	// The compressed length is not the declared one, and caches key on
	// Accept-Encoding once the response varies by it.
	h.Del("Content-Length")
	h.Add("Vary", "Accept-Encoding")
	w.ResponseWriter.WriteHeader(w.status)
	w.gz = gzipWriterPool.Get().(*gzip.Writer)
	w.gz.Reset(w.ResponseWriter)
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	if !w.decided {
		// Buffer until either the threshold is crossed (compress) or the handler
		// finishes below it (write through).
		if len(w.head)+len(b) < gzipMinBytes {
			w.head = append(w.head, b...)
			return len(b), nil
		}
		head := w.head
		w.head = nil
		w.decide(len(head) + len(b))
		if len(head) > 0 {
			if _, err := w.writeBody(head); err != nil {
				return 0, err
			}
		}
	}
	return w.writeBody(b)
}

func (w *gzipResponseWriter) writeBody(b []byte) (int, error) {
	if w.gz != nil {
		return w.gz.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

// close flushes whatever the decision turned out to be: a short response still
// held in the buffer, or the compressor's trailer.
func (w *gzipResponseWriter) close() {
	if !w.decided {
		w.decide(len(w.head))
		if len(w.head) > 0 {
			_, _ = w.writeBody(w.head)
		}
		w.head = nil
	}
	if w.gz != nil {
		_ = w.gz.Close()
		gzipWriterPool.Put(w.gz)
		w.gz = nil
	}
}

// Flush lets a streaming handler push bytes through the compressor. Reaching it
// means the response is already committed, so an undecided writer decides first.
func (w *gzipResponseWriter) Flush() {
	if !w.decided {
		w.decide(len(w.head))
		if len(w.head) > 0 {
			_, _ = w.writeBody(w.head)
			w.head = nil
		}
	}
	if w.gz != nil {
		_ = w.gz.Flush()
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// withCompression gzips text responses for clients that asked for it.
func withCompression(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r) {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipResponseWriter{ResponseWriter: w, req: r}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}
