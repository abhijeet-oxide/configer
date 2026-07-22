# Configer evaluation agents

Six independent, elite expert agents that evaluate **Configer** - the
write-back-native GitOps configuration UI - each from a fundamentally different
cognitive perspective. Their disagreements are intentional: a feature one
persona calls needless complexity, another calls essential transparency. Run
them independently, then synthesize.

| Agent | Lens | Core question |
|-------|------|---------------|
| `zero-context-explorer` | Discoverability, learnability, first contact | Can a newcomer with no prior knowledge orient and finish a first task unaided? |
| `product-owner-approver` | Business accountability, approval governance (non-technical) | Can a non-Git approver responsibly approve or reject a change and defend it later? |
| `enterprise-config-operator` | Daily productivity at fleet scale | Can a specialist manage a large, messy estate faster and more safely than spreadsheet-and-copy-paste? |
| `gitops-engineering-expert` | Technical correctness, Git-nativeness, transparency | Is Configer genuinely Git-native and faithful, or a veneer that breaks under concurrency, merges, and exotic formats? |
| `change-reviewer-governor` | Governance, auditability, traceability, recovery | Can changes be governed with audit-grade evidence and recovered confidently during an incident? |
| `human-centered-design-expert` | Cognitive load, mental models, IA, progressive disclosure, accessibility | Is it one coherent experience that serves the whole spectrum by design, not by omission? |

`_evaluation-contract.md` (leading underscore, no frontmatter - not an
invokable agent) holds the shared evidence discipline, required report
structure, and severity vocabulary every agent follows.

## How to run an evaluation

Spawn each agent independently (they should not read each other's output before
forming a verdict), e.g. via the Agent tool with `subagent_type` set to the
agent name. Point them at a live instance where possible:

```bash
make dev   # backend :8080 over ./sample-repo, frontend :5173
```

Richer fixtures live in `sample-repos/` (Helm umbrella, kustomize overlays,
kpt, multi-cluster, telco RAN); `make functional-test` exercises them. Agents
drive the running UI with the `webapp-testing` (Playwright) skill and cite
`file_path:line` from `backend/internal/` and `frontend/src/`.

## Severity vocabulary

- **Critical** - could cause an unsafe/incorrect configuration change, data
  loss, or silent divergence between approved and deployed state.
- **High** - would significantly damage adoption, trust, or productivity.
- **Medium** - meaningful friction or unnecessary cognitive load.
- **Low** - refinement that raises overall polish.

## Cross-agent synthesis (run after all six report)

The synthesis is not an average of the six reports; it is a higher-order
analysis. It must identify:

- **Convergence** - issues raised independently by multiple personas (strongest
  signal; usually systemic).
- **Segment-unique needs** - issues that matter only to one user group.
- **Genuine tensions** - where personas want opposite things (e.g. the
  operator wants density and speed; the explorer wants guidance and guardrails;
  the engineer wants full Git exposure; the approver wants none of it). Do not
  flatten these into one recommendation.
- **Where progressive disclosure resolves a tension** - and where it cannot, so
  a real product trade-off must be chosen.
- **Systemic categories** - product-level, workflow-level, information-
  architecture, technical-transparency, and trust/governance problems.
- **Prioritized, sequenced improvements** across the whole product, with the
  reasoning and trade-offs behind the ordering.
- **Open questions** requiring further user research or technical investigation.

The question the synthesis must ultimately answer: *Can Configer become the
interface through which humans with radically different technical knowledge
safely and confidently manage configuration-as-code, while Git remains the
reliable source of truth underneath?*
