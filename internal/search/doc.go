// Package search is the Hub-owned global search index. It indexes only
// application METADATA - parameter names/categories, instance names, and change
// request titles across every connected application - never configuration
// values or file contents (those stay cheap and app-scoped, searched on the
// client over the already-loaded grid). A search doc is a few hundred bytes, so
// the whole index at realistic scale is a few MB in memory; SQLite FTS5 backs it
// for durability and as an overflow buffer past a configurable cap.
package search

import "encoding/json"

// Doc types. Applications and commands are searched on the client (already
// instant from the workspace cache and the command registry), so the server
// indexes only what requires a cross-application view.
const (
	TypeParameter = "parameter"
	TypeInstance  = "instance"
	TypeChange    = "change"
)

// Target is the structured navigation intent a hit resolves to. It is encoded
// to JSON on the server and handed to the client untouched, so a hit minted here
// navigates through the exact same client-side resolver as a locally produced
// one. The vocabulary mirrors the frontend store's deep-links.
type Target struct {
	Kind  string `json:"kind"` // always "navigate" for server hits
	App   string `json:"app,omitempty"`
	View  string `json:"view"`
	Param string `json:"param,omitempty"`
	Inst  string `json:"inst,omitempty"`
}

// Badge is a small colored label rendered on a hit (e.g. a change's state).
type Badge struct {
	Text  string `json:"text"`
	Color string `json:"color,omitempty"`
}

// Doc is one indexed item. Keywords is the pre-lowered haystack a query matches
// against beyond the title; Target and Badges ride along so a hit is renderable
// and actionable without a second lookup.
type Doc struct {
	Type     string
	AppID    string
	DocID    string
	Title    string
	Subtitle string
	Keywords string
	Badges   []Badge
	Target   json.RawMessage
}

// Hit is the API-facing result. It is intentionally lightweight: identity, the
// two display lines, the keywords (so the client can re-rank uniformly with its
// local hits), the badges, and the target. Never a full document.
type Hit struct {
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	AppID    string          `json:"appId"`
	Title    string          `json:"title"`
	Subtitle string          `json:"subtitle,omitempty"`
	Keywords string          `json:"keywords,omitempty"`
	Badges   []Badge         `json:"badges,omitempty"`
	Target   json.RawMessage `json:"target"`
}

// encodeBadges serializes badges for the UNINDEXED FTS column ("" when none).
func encodeBadges(b []Badge) string {
	if len(b) == 0 {
		return ""
	}
	out, _ := json.Marshal(b)
	return string(out)
}

// decodeBadges is the inverse; a blank or malformed value yields no badges.
func decodeBadges(s string) []Badge {
	if s == "" {
		return nil
	}
	var b []Badge
	if err := json.Unmarshal([]byte(s), &b); err != nil {
		return nil
	}
	return b
}

func (d Doc) toHit() Hit {
	return Hit{
		Type:     d.Type,
		ID:       d.DocID,
		AppID:    d.AppID,
		Title:    d.Title,
		Subtitle: d.Subtitle,
		Keywords: d.Keywords,
		Badges:   d.Badges,
		Target:   d.Target,
	}
}
