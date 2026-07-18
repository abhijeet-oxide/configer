package api

// Documentation DTOs. Several handlers assemble ad-hoc map[string]any
// responses; these named structs give the generated OpenAPI real, referenceable
// schemas for those payloads without changing any runtime behavior (the
// handlers keep returning maps - the shapes are identical). Where a handler
// already returns a concrete model type, that type is referenced directly and
// no DTO is needed here.

// StatusResponse is a liveness/health answer.
type StatusResponse struct {
	Status  string `json:"status" example:"ok"`
	Version string `json:"version,omitempty" example:"1.4.0"`
}

// MetaResponse identifies the running deployment.
type MetaResponse struct {
	Name        string `json:"name" example:"Configer"`
	Version     string `json:"version" example:"1.4.0"`
	Environment string `json:"environment" example:"production" enums:"development,staging,production"`
	Project     string `json:"project,omitempty" example:"payments-platform"`
	Branch      string `json:"branch,omitempty" example:"main"`
}

// OKResponse is the minimal acknowledgement for actions with no resource body.
type OKResponse struct {
	OK bool `json:"ok" example:"true"`
}

// StagedResponse acknowledges a draft edit and reports the resulting draft
// size so a client can reflect the pending-changes badge without a re-fetch.
type StagedResponse struct {
	OK       bool `json:"ok" example:"true"`
	Staged   bool `json:"staged,omitempty" example:"true"`
	Pending  int  `json:"pending" example:"3"`
	ChangeID int  `json:"changeId" example:"7"`
}

// ValueStagedResponse acknowledges a validated value edit.
type ValueStagedResponse struct {
	OK       bool `json:"ok" example:"true"`
	Value    any  `json:"value"`
	Pending  int  `json:"pending" example:"3"`
	ChangeID int  `json:"changeId" example:"7"`
}

// ConnectRequest is the body for connecting a repository.
type ConnectRequest struct {
	// URL is a git URL (https/ssh) or an absolute local path.
	URL string `json:"url" example:"https://github.com/acme/platform-config"`
	// Name overrides the display name (defaults to the repo name).
	Name string `json:"name,omitempty" example:"Platform config"`
	// Branch is the working branch (defaults to the remote's default branch).
	Branch string `json:"branch,omitempty" example:"main"`
	// Token is an access token for a private repository. Stored server-side
	// only and never returned.
	Token string `json:"token,omitempty"`
	// Mode "remote" manages the repository through the GitHub API with no
	// clone; the default clones the repository.
	Mode string `json:"mode,omitempty" example:"clone" enums:"clone,remote"`
}

// RenameRequest renames an application (display name only).
type RenameRequest struct {
	Name string `json:"name" example:"Payments platform"`
}

// ValueEditRequest stages a validated cell edit into the draft.
type ValueEditRequest struct {
	ParamID  string `json:"paramId" example:"net-admin-port"`
	Instance string `json:"instance" example:"prod-us-east"`
	// Value is a type-appropriate value, coerced and validated server-side.
	Value any `json:"value" swaggertype:"string" example:"8443"`
	// Scope "global" edits the shared value for every instance; omit for a
	// per-instance override.
	Scope string `json:"scope,omitempty" example:"" enums:"global"`
	// Action defaults to "set". "reset" drops the instance override; "exclude"
	// removes the key from the instance's files entirely.
	Action string `json:"action,omitempty" example:"set" enums:"set,reset,exclude"`
}

// FileEditRequest stages a whole-file (Monaco) edit into the draft.
type FileEditRequest struct {
	Instance string `json:"instance,omitempty" example:"prod-us-east"`
	Path     string `json:"path" example:"instances/prod-us-east/values.yaml"`
	Content  string `json:"content"`
}

// SubmitChangeRequest turns a draft into a branch + commit + pull request.
type SubmitChangeRequest struct {
	Title       string `json:"title" example:"Raise admin port in production"`
	Description string `json:"description,omitempty"`
	Reference   string `json:"reference,omitempty" example:"JIRA-1234"`
	Category    string `json:"category,omitempty" example:"networking"`
}

// CommentRequest appends a review note to a change request.
type CommentRequest struct {
	Body string `json:"body" example:"Looks good, ship after the window."`
}

// ReviewersRequest replaces the (informational) reviewer list.
type ReviewersRequest struct {
	Reviewers []string `json:"reviewers" example:"alice,bob"`
}

// SetMemberRequest assigns a role on one application.
type SetMemberRequest struct {
	Login string `json:"login" example:"alice"`
	Role  string `json:"role" example:"editor" enums:"viewer,editor,approver"`
}
