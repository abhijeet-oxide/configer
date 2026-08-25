# YANG validation

This note is for future agents working on Configer's schema validation. It
captures what exists today, what it guarantees, what it deliberately does not,
and what is left.

## The shape: two tiers, and why neither replaces the other

**Tier 1 - extraction and per-value rules.** `yangschema` reads the models a
repository ships and turns what they say into `model.Validation`. Those rules
are enforced by `validate.Value` on every write path and mirrored in the browser
(`frontend/src/rules.ts`) so a bad value is visible while it is still being
typed. This is what an editor needs.

**Tier 2 - whole-document validation.** `yangvalidate` holds the candidate
document a change WOULD commit against the model set. It answers the questions
that only have an answer once the whole file exists: a mandatory leaf left out,
two list entries colliding on a key, a reference pointing at nothing, a `must`
condition spanning three settings. It runs at SUBMIT, when the change is
complete and about to become somebody else's problem.

Neither tier replaces the other. Tier 1 cannot see across values; tier 2 cannot
run per keystroke.

A **missing validator is a STATE, not a pass.** `Report.Available` says whether
full validation actually ran. Anything that treats "no findings" and "nothing
looked" alike has turned the gate off without noticing, and the UI is written to
never say a change is model-valid when nothing checked it.

## Where the code is

- `backend/internal/yangschema/` - the parser, the model index, and the mapping
  from YANG facts to Configer validation.
  - `parse.go` - the statement tree (every YANG construct is `keyword arg { … }`,
    extensions included, so an unknown vendor keyword is carried not refused)
  - `schema.go` - nodes, types, restrictions, `uses`/`refine`/`augment`/`choice`
  - `index.go` - loading a set, route indexing, lookup, feature gating
  - `identity.go` - identity/identityref resolution and `if-feature` expressions
  - `deviation.go` - applying `deviation` after the whole set is indexed
  - `regex.go` - XSD regular expression to Go translation
  - `apply.go` - mapping a model node onto a `model.Parameter`
- `backend/internal/yangvalidate/` - whole-document validation.
  - `validate.go` - `Engine`, `Finding`, `Report`, engine selection
  - `document.go` - YAML/JSON/XML into a named node tree with paths and lines
  - `native.go` - the built-in document walker
  - `xpath.go` - the bounded XPath subset for `must`/`when`
  - `yanglint.go` - the libyang bridge and diagnostic normalization
- `backend/internal/api/models.go` - the cached model set, and the
  `(file, path) -> parameter` locator that puts a finding on the row somebody
  edited
- `backend/internal/api/validation.go` / `validationrun.go` - the run resource
  and the submit gate
- `backend/internal/discovery/models.go` - attaching model facts during
  onboarding and linking dependencies
- `frontend/src/components/ValidationFlow.tsx` - the staged, live submit UI

## What tier 1 extracts

Structure: `module`, `submodule`, `belongs-to`, `include`, `typedef` (including
chained restrictions and typedef-level `default` / `units` / `description`),
`grouping`, `uses`, `refine` (description, mandatory, default, config,
min/max-elements, units, and ADDED `must`), `augment` (module-level and
`uses`-local), `container`, `list`, `leaf`, `leaf-list`, `choice`/`case` (with
the choice and case each node belongs to recorded), `key`, `mandatory`,
`presence`, `status`, `ordered-by`, `unique`, `min-elements`/`max-elements`,
`if-feature`, `deviation` (`not-supported`, `add`, `replace`, `delete`),
`identity`/`base`, vendor extension labels and defaults by unprefixed keyword.

Types: every integer width, `decimal64` with `fraction-digits`, `boolean`,
`empty`, `enumeration`, `bits`, `union`, `leafref` (with `require-instance`),
`identityref`, `instance-identifier`, `binary`, `string`, plus RFC 6991 semantic
types mapped onto Configer's operational types (IPv4/IPv6/prefix/port/
domain-name/URI/MAC).

Restrictions: `range`, `length`, `pattern` (including `invert-match` and
accumulated patterns through a typedef chain), `enum`, `bit`, `error-message`,
`units`, `default`.

**An augment and the module it targets produce two top-level nodes of the same
name**, because an augment spells out the whole route to its target. They are
MERGED (`Node.Merge`, `mergeSiblings`) before anything is indexed. Without that,
whichever file sorted first became the tree - and a walk down it found one leaf
where the model has fifteen.

## What is enforced, and where

Enforced per value, by `validate.Value`, on every write path and in the browser:

- `required` from `mandatory` and list keys
- data type and format (integer/number/boolean/enum/IPv4/IPv6/CIDR/hostname/
  port/email/URL/MAC/CPU/memory/duration/percentage)
- numeric min/max from `range`, and the integer type's own width when no range
  was stated
- **disjoint ranges and lengths** (`Validation.Ranges` / `Lengths`). A single
  min/max cannot say "5..20 or 40..100": it accepts 30, which the vendor wrote
  the restriction to refuse. Min/Max still carry the outer span so an older
  client validates loosely; the spans are what decides.
- string min/max length
- `enum`, including **the identities derived from an `identityref`'s base** -
  an ordinary list of choices, and the most useful thing the schema knew about
  a setting that used to arrive as "a string"
- regular expressions, **translated from XSD rather than hoped over**. Class
  subtraction (`[a-z-[aeiou]]`) compiles in Go as a DIFFERENT rule - one that
  admits exactly the characters the vendor excluded - so `regex.go` translates
  `\i`, `\c`, `\p{Is…}` blocks and subtraction, and refuses (falling back to
  prose) rather than enforcing an approximation.
- **inverted patterns** (`NotPatterns`) - the one restriction a vendor bothered
  to invert used to be the one nothing checked
- **`bits`** - a value is any subset of the declared flags; listing them in
  prose let a typo through to the device
- **`union`** (`AnyOf`) - checked WHOLE, so "a number in 1..100 or the word
  auto" accepts both legitimate spellings and refuses neither
- **`fraction-digits`** (`MaxDecimals`)
- **`config false`** (`ReadOnly`) - the cell is shown and never editable
  (`grid.Cell.Editable`); writing device state back would be overwritten by the
  next read
- cross-parameter relations Configer already had (`AtLeast`/`AtMost`)

Enforced per document, by `yangvalidate`, at submit:

- mandatory leaves absent from a level the document has reached
- list keys: present, and not repeated across entries
- `unique` statements (entries missing any named leaf are exempt, per RFC 7950)
- `leafref` targets that exist, honouring `require-instance false`
- `min-elements` / `max-elements`, including on an EMPTY collection
  (`Node.Repeated` exists for exactly this: read as "no entries", an empty list
  looked like an absent one and slipped through saying nothing)
- `choice`: two cases filled in, or a mandatory choice with none
- `must` and `when`, within the subset `xpath.go` reads
- every leaf's own type and restrictions, because a file edited by hand never
  went through the cell write path

## What is deliberately NOT done

- **An expression outside the XPath subset produces NO finding.** A condition
  guessed at is worse than one nobody checked, because a reader cannot tell them
  apart, and a false refusal on a correct change is how people learn to click
  past a gate. The count of skipped checks is reported.
- **A path that leaves the file says nothing.** A datastore has one tree; a
  repository has files. A `leafref` or `../..` reaching past what this file holds
  is a question the file cannot answer, not a violation.
- **Predicates in a location path are stripped, not evaluated.** That widens a
  node set, which for the supported comparisons can only turn a refusal into a
  pass - never a pass into a refusal. Widening in that direction is the safe
  error to make.
- **Only the files a change TOUCHES are validated.** A repository whose
  committed state already breaks a rule is not this change's fault, and
  reporting it would make every submit carry somebody else's backlog.
- **Unmodelled content is counted, not refused.** Real repositories hold
  Kubernetes envelopes, Helm values and readme fragments beside whatever the
  models describe. `Report.Unmatched` says how much, and the UI says so.
- **`if-feature` defaults to "every feature enabled".** Nothing in a repository
  says which features a build shipped with. A rule attached to a node that turns
  out not to exist costs a warning about a setting nobody set; dropping the node
  costs every rule on a setting somebody is editing right now.
  `CONFIGER_YANG_FEATURES` makes the gate real where a deployment knows.

## The engines

`yangvalidate.Select()` picks one, most capable first:

| engine | available | covers |
|---|---|---|
| `yanglint` | when the binary is on PATH (or `CONFIGER_YANGLINT` names it) | the whole language: full XPath, deviations, features, cross-module leafrefs, unique, keys |
| `native` | always | the checks listed above, over one file at a time |

`CONFIGER_YANG_VALIDATOR=auto|native|yanglint|off` overrides. Naming an engine
explicitly reports it unavailable rather than falling back, because a deployment
that asked for yanglint wants to know when it is missing.

**yanglint is not required, and must not become required.** libyang is a C
library: a package on Linux, an afternoon with MSYS2 or vcpkg on Windows.
Demanding it would mean a developer cannot run the product on their own laptop.
Ship it in the production container; let a Windows developer use WSL or Docker
if they want the deeper checks; carry the tier with `native` everywhere else.

## The submit gate

`POST /api/changes/{id}/submit` validates before anything is branched,
committed or pushed. The client normally ran the check already and watched it
happen (`POST /api/changes/{id}/validation` then poll `GET`), and the gate runs
again at submit because **a gate a caller can skip by not calling an endpoint is
not a gate**. A run is reused only when its fingerprint still matches the draft.

Blocking findings answer 422 with the whole run attached, so the dialog can show
what is wrong and where rather than a toast saying "invalid".

`override: true` with `overrideReason` submits anyway and writes the reason into
the change's own description, which travels into the commit message and the PR
body. This exists because the alternative to a recorded override is not "no
overrides" - it is somebody switching the validator off in an environment
variable, where no reviewer will ever see it.

## Capability reporting

`GET /api/validation/status` answers what this deployment can check: whether the
repository ships models, how many were read, which engine would run, why one
would not, and every engine's availability. The UI uses it to promise a model
check only where there is a model to check against.

## The UI

`ValidationFlow.tsx` draws the check rather than spinning through it. Five
stages are laid out before any of them starts (so the reader sees the whole road
rather than a list growing under them), the running one is the only thing
moving, each finished one says in words what it actually did, and it ends on a
verdict that is a shape AND a colour AND a sentence. A failure lists each
problem with the setting it belongs to, the file and line, the schema's own
expression, which model file stated the rule, and a way to go and fix it.

`Rules detected in release schema` (RuleEditor) shows the enforceable facts the
editable fields cannot carry - alternatives, flags, disjoint spans, an inverted
pattern, a decimal precision, and read-only state - as facts with their source
named, never as controls.

## What is left

Worth doing, roughly in order:

1. **Merge documents per instance scope before validating.** Today each changed
   file is validated on its own, so a `leafref` crossing from one file to
   another in the same instance folder resolves to "not answerable" and is
   passed over. Merging an instance's config files into one tree (with
   per-node file provenance, which `Node.File` already carries) would make those
   references real.
2. **Wire tier 2 into the direct file-draft save** (`api/files.go`), after the
   syntax check and the catalog delta. It is the same call; it just needs the
   candidate bytes.
3. **`instance-identifier` resolution** and `identityref` values spelled with a
   module prefix in the document.
4. **Feature discovery from a product descriptor**, so `CONFIGER_YANG_FEATURES`
   stops being the only way to make the gate real.
5. **Widen the XPath subset** only where real models need it, and only with a
   test per construct. Every addition is a chance to refuse a correct change.
6. **Ship yanglint in the deployment image** and document the WSL/Docker route
   for Windows developers.

## Test coverage to keep

`yangschema`: typedef chains, enum/range/length/pattern/default/label/
description, grouping and refine, augment from another file, dependency
extraction from `when`/`must`/`leafref`, ambiguity refusal, prefix and index
stripping, identityref values, deviations (replace and not-supported),
disjoint ranges, unions, bits, inverted patterns, XSD class subtraction,
`config false`, choice/case/presence, feature gating.

`yangvalidate`: a valid document producing NOTHING (a validator that cries wolf
is one people click past), mandatory, keys, unique, leafref, min-elements,
`must`, `when`, choice both-branches and none, per-value rules on a hand-edited
file, JSON and XML documents, unmodelled content counted not refused, an
unparseable file skipped not blamed on the model, and no-models reported as a
state rather than a pass.

`api`: capability reporting with and without models, every stage passing on a
valid change, a model-range violation refused with the finding mapped to its
parameter, a submit that never called the validation endpoint still gated, and
an override recorded in the change.
