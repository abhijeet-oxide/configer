# YANG validation roadmap

This note is for future agents working on Configer's schema validation. It captures what exists today, what it guarantees, what it does not guarantee yet, and the recommended next steps.

## Current shape

Configer has two validation layers today:

1. **Catalog validation** - parameter metadata in `.configer/parameters.yaml` carries `model.Validation` rules. Those rules are enforced by the backend write paths with `validate.CoerceValue` and `validate.Value`.
2. **Schema extraction** - discovery reads schema files and converts schema facts into `model.Validation`, parameter descriptions, display names, defaults, types, and dependencies.

The schema extraction layer is intentionally optional. A repository without schema files still onboards and edits normally.

## Where YANG is read

The YANG support lives in:

- `backend/internal/yangschema/` - parses YANG files, builds a model index, maps YANG nodes to Configer parameter validation.
- `backend/internal/discovery/models.go` - detects product metadata, loads YANG model sets, attaches model facts to discovered parameters, and links dependencies.
- `backend/internal/discovery/discovery.go` - calls the YANG attachment after JSON Schema attachment and before fallback type inference.

Product metadata discovery lives in:

- `backend/internal/productmeta/` - detects instance folders containing `CONFIGURATION`, `METADATA`, and a descriptor such as `METADATA/product.txt`.

That descriptor is not Nokia-specific in code. It is just a recognized product descriptor pattern. When found, it fills:

- application proposal product metadata (`discovery.Result.Product`)
- instance software version
- instance environment from `envtype`
- product/release/variant labels

## What YANG extraction handles today

The native Go extractor currently parses and uses these YANG constructs:

- `module` and `submodule`
- `include`, in practice by loading all `.yang` files in the selected schema directories
- `belongs-to`
- `typedef`, including chained typedef restrictions
- `grouping` and `uses`
- `refine` under `uses`
- `augment`, including module-level augment and `uses`-local augment
- `container`, `list`, `leaf`, `leaf-list`
- `choice` and `case`, flattened for address lookup
- `key`, making list key leaves required
- `mandatory`
- `default`, including vendor extension defaults such as `alu:default`
- `description`
- extension labels such as `alu:label`, `nok-ext:label`, and other prefixed `label` or `info`
- `units`
- `min-elements` and `max-elements`
- `type` restrictions:
  - integer and unsigned integer widths
  - `range`
  - `length`
  - `pattern`, including multiple accumulated patterns from typedef chains
  - `enumeration`
  - `bits`, as readable constraints
  - `union`, as readable constraints
  - `leafref`, as readable constraints and as dependency references
- common semantic YANG types mapped to Configer types:
  - IPv4 and IPv6 address types
  - IP prefix types
  - port number types
  - domain/host name types
  - URI
  - MAC/physical address types
- `must` and `when` expressions, currently as readable constraints and conservative dependency references
- `unique`, currently as a readable constraint

The extractor indexes nodes by route rather than by namespace. Config documents and YANG modules often spell prefixes differently, while the route of node names is the stable common ground. Matching prefers the longest common suffix and refuses ambiguous matches when two different schema nodes would produce different rules.

## What is enforced today

Once YANG facts are mapped into `model.Validation`, they are enforced server-side anywhere Configer writes values through normal parameter write paths.

Enforced today:

- required values from `mandatory` and list keys
- data type coercion and checks:
  - integer
  - number
  - boolean
  - enum
  - IPv4
  - IPv6
  - CIDR
  - hostname
  - port
  - email
  - URL
  - MAC
  - CPU, memory, duration, percentage where inferred or mapped
- numeric min/max from YANG `range`
- integer built-in bounds for types like `uint8`, `uint16`, `int16`, etc. where representable
- string min/max length from YANG `length`
- enum allowed values
- regular expression patterns that compile in Go
- multiple accumulated patterns via `Validation.Pattern` plus `Validation.Patterns`
- list min/max item counts when the Configer parameter represents the whole list
- cross-parameter resource relations already present in Configer (`AtLeast`, `AtMost`) for resource limits and requests

The backend write paths that call validation include at least:

- cell value edits in `backend/internal/api/values.go`
- file draft catalog deltas in `backend/internal/api/files.go`
- restores in `backend/internal/api/restore.go`
- source accepts in `backend/internal/api/sources.go`
- grid validity calculation in `backend/internal/grid/grid.go`

## What is displayed but not fully enforced

Some YANG facts are preserved as readable constraints rather than enforced rules:

- `must` XPath expressions
- `when` XPath expressions
- `unique`
- disjoint ranges that cannot be represented as a single min/max span
- inverted patterns that cannot be represented directly
- uncompiled YANG/XSD regex features that Go regexp cannot compile
- `union` member validation
- `bits` semantics
- `leafref` target existence and target-value checking

This is deliberate. Enforcing these correctly requires whole-document validation, not single-cell validation.

## Dependencies today

`Parameter.DependsOn` is now built conservatively from YANG references:

- `leafref { path "..."; }`
- path-like references inside `when`
- path-like references inside `must`

The flow is:

1. `yangschema.Node.DependencyPaths` records the raw schema paths.
2. `yangschema.Set.LookupDependency` resolves absolute paths like `/a/b/c` and relative paths like `../enabled` from the source node.
3. `discovery.linkModelDependencies` converts resolved target nodes into actual parameter IDs after discovery has assigned IDs.
4. The frontend dependency tab reads the existing `Parameter.DependsOn` field and shows reverse dependencies by scanning the grid rows.

Rules for dependency linking:

- Only leaf-like schema targets become dependencies.
- The target must correspond to a discovered Configer parameter.
- Ambiguous references are ignored rather than guessed.
- Structural references and unresolved expressions remain readable validation constraints.

This means the dependency graph is useful and safe, but not complete.

## Important known gaps

The native Go extractor is not a complete YANG validator. It is a metadata, rule, and dependency extractor.

Missing or incomplete areas:

- full namespace-aware XML-to-module resolution
- full RFC 7950 XPath evaluation for `must` and `when`
- full `leafref` validation against candidate document values
- `unique` enforcement over list entries
- `choice` and `case` exclusivity validation
- `presence` container semantics
- `if-feature` evaluation and feature-set configuration
- `deviation` handling
- `identity`, `identityref`, and base identity resolution
- exact XSD regular expression semantics beyond what can be safely converted to Go regexp
- complete document-level validation before save/submit
- high-quality mapping of full-schema validation errors back to Configer parameter IDs and editor locations

## Recommended next step: add full-document YANG validation

Do not try to hand-roll the missing YANG validation in Go. Keep the Go extractor for UI metadata and fast local rules, and add an optional full-document validator for backend write gates.

Recommended architecture:

1. Add a package such as `backend/internal/yangvalidate`.
2. Define a small interface:

```go
type Validator interface {
    Available() bool
    Validate(ctx Context, doc Document) Result
}
```

3. Provide implementations:

- `NoopValidator` - used when no full validator is available. It reports unavailable, not success.
- `YanglintValidator` - shells out to `yanglint` from libyang.
- Optional future `LibyangValidator` - direct bindings, only if worth the operational cost.

4. Cache schema contexts by product version and schema root.
5. On save or submit, apply the candidate edit to a temporary copy of the whole file, then validate that whole file.
6. Reject the save with normalized file/path/message diagnostics if validation fails.

## Why `yanglint`

`yanglint` is the best practical validation engine for full YANG semantics. It comes from libyang, is widely used, and supports the hard parts that should not be reimplemented casually:

- imports/includes
- augment
- deviations
- features
- leafrefs
- must/when XPath
- list keys and uniqueness
- full data tree validation

## Windows support

Do not make `yanglint` mandatory for ordinary Windows development.

Native Windows support is possible but awkward because libyang is a C library. Developers usually need MSYS2, vcpkg, or custom setup. The better path is:

- Linux production container: include `yanglint`/libyang tools.
- Windows developer machine: support WSL or Docker for full validation.
- If `yanglint` is absent: keep Go-derived validation active and expose full YANG validation as unavailable.

Missing validator must be a state, not a fatal error.

## Capability reporting

Expose this in capabilities or repo metadata so the UI and operators know what level is active:

```json
{
  "yangSchemaDetected": true,
  "yangValidationAvailable": true,
  "yangValidator": "yanglint",
  "schemaVersion": "25.7.1120"
}
```

When unavailable, the UI should avoid saying the repository is fully YANG-valid. It can still say schema-derived rules are active.

## Validation pipeline target state

Target state for a parameter edit:

1. UI editor uses `model.Validation` for immediate feedback.
2. Backend coerces and validates the scalar value using `validate.Value`.
3. Backend applies the edit to a temporary full document.
4. Full-document YANG validator validates the candidate document.
5. If valid, Configer stages the draft item or file draft.
6. If invalid, the response includes the validator message, file, line/path when available, and ideally the mapped parameter ID.

Target state for direct file edit:

1. Syntax check first, as today.
2. Catalog delta calculation, as today.
3. Apply candidate text to temp file.
4. Full-document YANG validation when schema applies to that file.
5. Reject with document diagnostics if invalid.

## Test coverage to keep

Current YANG tests should keep covering:

- typedef restriction chains
- enum/range/length/pattern/default/label/description extraction
- grouping and refine
- augment from a different file
- dependency extraction from `when`, `must`, and `leafref`
- ambiguity refusal
- prefix/index stripping during route matching

When full validation is added, add tests for:

- valid and invalid `must`
- valid and invalid `when`
- `leafref` target exists / missing
- `unique` violations
- list key violations
- choice/case violations
- feature-disabled nodes
- deviation-modified constraints
- error normalization from `yanglint` output

## Practical priority order

1. Keep strengthening extraction only where it improves UI and safe scalar validation.
2. Add the `yangvalidate` abstraction.
3. Implement `YanglintValidator` behind capability detection.
4. Wire full validation into cell writes and direct file draft saves.
5. Normalize errors and map them to parameter IDs where possible.
6. Add container/WSL documentation and Docker packaging.
7. Only then consider deeper native Go validation for the small subset that remains useful without invoking a full validator.
