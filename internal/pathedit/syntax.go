package pathedit

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// SyntaxError is a document that will not parse, said in the terms the person
// looking at their editor needs: what is wrong, and WHERE.
//
// A save that only answered "the file does not parse: yaml: line 12: did not
// find expected key" made the reader hunt for line 12 themselves, in a file of
// nine hundred lines, with the parser's own vocabulary for company. The place
// is the most actionable part of the answer, so it is a field rather than
// something buried in a sentence.
type SyntaxError struct {
	// Message is the failure in plain words, with the parser's own wording kept
	// as the tail (it is often the only thing that says WHAT is unbalanced).
	Message string `json:"message"`
	// Line/Column are 1-based positions in the document, 0 when the parser could
	// not say. Column is frequently unknown: YAML and XML report a line only.
	Line   int `json:"line,omitempty"`
	Column int `json:"column,omitempty"`
	// Snippet is the offending line's own text, trimmed, so the message can show
	// the reader what it is talking about without a second round trip.
	Snippet string `json:"snippet,omitempty"`
}

func (e *SyntaxError) Error() string {
	if e.Line > 0 {
		return fmt.Sprintf("line %d: %s", e.Line, e.Message)
	}
	return e.Message
}

// CheckSyntax reports whether a document is well-formed in its format, and
// where it stops being so. It returns nil for a document that parses (an empty
// one included: an empty file is a legitimate state, not a syntax error).
//
// It is deliberately a WHOLE-DOCUMENT check rather than a by-product of
// reading a path. Reading a path only notices damage that happens to sit on
// the way to that path, so a stray brace three hundred lines below every
// managed value parsed as "fine" and was committed.
func CheckSyntax(doc []byte, format string) *SyntaxError {
	if len(bytes.TrimSpace(doc)) == 0 {
		return nil
	}
	switch normFormat(format) {
	case "xml":
		return checkXML(doc)
	case "json":
		return checkJSON(doc)
	default:
		return checkYAML(doc)
	}
}

// yamlLine pulls the line out of a yaml.v3 error, which spells it "line 12:"
// at the front of the message (sometimes twice, once per nesting level).
var yamlLine = regexp.MustCompile(`line (\d+):`)

func checkYAML(doc []byte) *SyntaxError {
	dec := yaml.NewDecoder(bytes.NewReader(doc))
	for {
		var node yaml.Node
		err := dec.Decode(&node)
		if err == io.EOF {
			return nil
		}
		if err == nil {
			continue // this document parsed; a stream may hold several
		}
		msg := strings.TrimSpace(err.Error())
		line := 0
		if m := yamlLine.FindStringSubmatch(msg); m != nil {
			line, _ = strconv.Atoi(m[1])
			// Drop the position from the sentence: it is a field now, and
			// repeating it made the message read as though there were two.
			msg = strings.TrimSpace(strings.TrimPrefix(msg[strings.Index(msg, m[0])+len(m[0]):], " "))
		}
		msg = strings.TrimPrefix(msg, "yaml: ")
		return &SyntaxError{Message: withYAMLHint(msg), Line: line, Snippet: lineAt(doc, line)}
	}
}

// withYAMLHint turns the two YAML failures people actually hit into advice.
// "did not find expected key" is almost always an indentation slip, and the
// parser's own phrasing tells the reader nothing they can act on.
func withYAMLHint(msg string) string {
	switch {
	case strings.Contains(msg, "did not find expected key"),
		strings.Contains(msg, "mapping values are not allowed"):
		return msg + " (check this line's indentation, and that the key ends with a colon)"
	case strings.Contains(msg, "found unexpected end of stream"),
		strings.Contains(msg, "did not find expected node content"):
		return msg + " (something opened here and was never closed)"
	}
	return msg
}

func checkJSON(doc []byte) *SyntaxError {
	var v any
	err := json.Unmarshal(doc, &v)
	if err == nil {
		return nil
	}
	offset := int64(-1)
	switch e := err.(type) {
	case *json.SyntaxError:
		offset = e.Offset
	case *json.UnmarshalTypeError:
		offset = e.Offset
	}
	msg := strings.TrimSpace(err.Error())
	msg = strings.TrimPrefix(msg, "invalid character ")
	if offset < 0 {
		return &SyntaxError{Message: msg}
	}
	line, col := lineCol(doc, offset)
	// json's own messages name the character but never the thing a person is
	// actually missing, which is nearly always the separator before it.
	if strings.Contains(msg, "after object key:value pair") || strings.Contains(msg, "after array element") {
		msg += " - a comma is probably missing"
	}
	return &SyntaxError{
		Message: "invalid character " + msg[:min(len(msg), 200)],
		Line:    line, Column: col, Snippet: lineAt(doc, line),
	}
}

func checkXML(doc []byte) *SyntaxError {
	dec := xml.NewDecoder(bytes.NewReader(doc))
	// The repository's files are ordinary UTF-8 configuration; a charset
	// declaration we cannot decode is a real problem worth reporting, not
	// something to paper over.
	for {
		_, err := dec.Token()
		if err == io.EOF {
			return nil
		}
		if err == nil {
			continue
		}
		if se, ok := err.(*xml.SyntaxError); ok {
			return &SyntaxError{
				Message: se.Msg + xmlHint(se.Msg),
				Line:    se.Line,
				Snippet: lineAt(doc, se.Line),
			}
		}
		return &SyntaxError{Message: strings.TrimSpace(err.Error())}
	}
}

func xmlHint(msg string) string {
	switch {
	case strings.Contains(msg, "element <"):
		return " (an opening and closing tag do not match)"
	case strings.Contains(msg, "unexpected EOF"):
		return " (a tag opened above and was never closed)"
	}
	return ""
}

// lineCol converts a byte offset into a 1-based line and column.
func lineCol(doc []byte, offset int64) (line, col int) {
	if offset < 0 {
		return 0, 0
	}
	if offset > int64(len(doc)) {
		offset = int64(len(doc))
	}
	head := doc[:offset]
	line = bytes.Count(head, []byte("\n")) + 1
	if i := bytes.LastIndexByte(head, '\n'); i >= 0 {
		col = len(head) - i
	} else {
		col = len(head) + 1
	}
	return line, col
}

// lineAt returns the 1-based line's own text, trimmed and capped, for showing
// the reader the place the message is about.
func lineAt(doc []byte, line int) string {
	if line <= 0 {
		return ""
	}
	lines := bytes.Split(doc, []byte("\n"))
	if line > len(lines) {
		return ""
	}
	s := strings.TrimSpace(string(lines[line-1]))
	if len(s) > 160 {
		s = s[:160] + "…"
	}
	return s
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
