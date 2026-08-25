import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Tooltip, Typography } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  MinusCircleOutlined,
  ReloadOutlined,
  RightOutlined,
} from "../icons";
import { api, type ValidationFinding, type ValidationRun, type ValidationStage } from "../api";
import { InlineNotice } from "./ui";

// Submitting is the moment a change stops being one person's work, so it is
// the moment everything that can be checked gets checked - and the moment the
// person doing it most needs to be told what is happening.
//
// The old shape of this was a button that went into a spinner. On a fleet-sized
// change against a few hundred YANG modules that is several seconds of a dialog
// that looks broken, at exactly the point somebody is committing to a
// production change, and the two outcomes ("done" and "something is wrong")
// arrived as the same grey toast.
//
// So the validation is DRAWN. The four stages are laid out before any of them
// starts, so the reader sees the whole road rather than a list growing under
// them; the running one is the only thing moving; each finished one says in
// words what it actually did, because a stage that only reports "passed" cannot
// be told from one that did nothing. It ends on a verdict that is a shape and a
// colour and a sentence at once, and a failure lists what is wrong with a way
// to go and fix each one.

/** How often the run is polled. Fast enough that the stages visibly move,
 *  slow enough that a three-second validation is not sixty requests. */
const POLL_MS = 350;

/** What the flow is doing, which is not the same as what the RUN is doing:
 *  submitting happens after a run has passed. */
type Phase = "validating" | "submitting" | "submitted" | "failed" | "broken";

export interface SubmitOutcome {
  number?: number;
  id: number;
  prUrl?: string;
}

export default function ValidationFlow({
  changeId,
  submit,
  onDone,
  onCancel,
  onOpenParam,
}: {
  changeId: number;
  /** Runs the actual submit once validation has passed (or been overridden). */
  submit: (opts: { override?: boolean; overrideReason?: string }) => Promise<SubmitOutcome>;
  onDone: (outcome: SubmitOutcome) => void;
  /** Go back to the list of changes so something can be fixed. */
  onCancel: () => void;
  onOpenParam?: (paramId: string) => void;
}) {
  const qc = useQueryClient();
  const [run, setRun] = useState<ValidationRun | null>(null);
  const [phase, setPhase] = useState<Phase>("validating");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [showOverride, setShowOverride] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Polling has to stop when this unmounts, and it has to stop when the run
  // finishes. A ref rather than state because the poll loop reads it between
  // renders.
  //
  // It is re-armed on every mount, not just initialized once. React mounts,
  // unmounts and remounts a component in development, and a guard that only
  // ever moves from true to false was left false by that first teardown - so
  // the second mount started a validation and then discarded every answer it
  // got, and the dialog sat on its first stage forever.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Start a run, then watch it. The whole point of the run being a resource is
  // that the browser is never blocked on it.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPhase("validating");
    setError(null);
    setRun(null);

    const watch = async (id: number, runId: string) => {
      try {
        const next = await api.validationRun(id, runId);
        if (stopped || !alive.current) return;
        setRun(next);
        if (next.state === "running") {
          timer = setTimeout(() => void watch(id, runId), POLL_MS);
          return;
        }
        if (next.state === "passed") {
          void doSubmit({});
          return;
        }
        setPhase(next.state === "error" ? "broken" : "failed");
      } catch (e) {
        if (stopped || !alive.current) return;
        // A poll that cannot reach the service has not validated anything, and
        // saying nothing would leave the dialog frozen - the exact thing this
        // component exists to prevent.
        setError(e instanceof Error ? e.message : String(e));
        setPhase("broken");
      }
    };

    api
      .startValidation(changeId)
      .then((started) => {
        if (stopped || !alive.current) return;
        setRun(started);
        timer = setTimeout(() => void watch(changeId, started.id), POLL_MS);
      })
      .catch((e: Error) => {
        if (stopped || !alive.current) return;
        setError(e.message);
        setPhase("broken");
      });

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeId, attempt]);

  const submitting = useMutation({
    mutationFn: (opts: { override?: boolean; overrideReason?: string }) => submit(opts),
    onSuccess: (res) => {
      setOutcome(res);
      setPhase("submitted");
      qc.invalidateQueries();
    },
    onError: (e: Error) => {
      setError(e.message);
      setPhase("broken");
    },
  });
  const doSubmit = async (opts: { override?: boolean; overrideReason?: string }) => {
    setPhase("submitting");
    submitting.mutate(opts);
  };

  // The submit is a fifth step in the reader's mind, so it is a fifth step on
  // the rail. Splicing it in here rather than having the server report it keeps
  // the server honest about what IT did.
  const stages: ValidationStage[] = useMemo(() => {
    const base = run?.stages ?? PLACEHOLDER_STAGES;
    const submitStage: ValidationStage = {
      id: "submit",
      label: "Creating the review branch",
      state:
        phase === "submitted" ? "passed"
          : phase === "submitting" ? "running"
            : phase === "failed" || phase === "broken" ? "skipped"
              : "pending",
      detail:
        phase === "submitted" && outcome
          ? `CR-${outcome.number ?? outcome.id} opened for review`
          : phase === "failed"
            ? "not reached - fix the problems below first"
            : undefined,
    };
    return [...base, submitStage];
  }, [run, phase, outcome]);

  const errors = (run?.findings ?? []).filter((f) => f.severity === "error");
  const warnings = (run?.findings ?? []).filter((f) => f.severity === "warning");
  const problems = run?.problems ?? [];
  const done = phase === "submitted" || phase === "failed" || phase === "broken";

  return (
    <div className="cf-vflow">
      <StageRail stages={stages} />

      {/* The verdict: a shape, a colour and a sentence at once, so it survives
          being read quickly, in greyscale, or by somebody who cannot separate
          the hues. */}
      {done && (
        <Verdict
          phase={phase}
          errors={errors.length}
          problems={problems.length}
          warnings={warnings.length}
          outcome={outcome}
          error={error}
        />
      )}

      {/* What was NOT checked is part of the answer. "Your change is valid" and
          "nothing looked at your change" must never read the same. */}
      {run && !run.available && phase !== "broken" && (
        <InlineNotice tone="info">
          {run.reason || "The deeper model checks did not run here."}
        </InlineNotice>
      )}
      {run && run.available && phase === "submitted" && run.unmatched > 0 && errors.length === 0 && (
        <InlineNotice tone="neutral">
          {run.unmatched} setting{run.unmatched === 1 ? "" : "s"} in the files this change touches
          {run.unmatched === 1 ? " is" : " are"} not described by any model, so nothing could check
          {run.unmatched === 1 ? " it" : " them"}.
        </InlineNotice>
      )}

      {problems.length > 0 && (
        <FindingGroup
          title="These edits could not be applied to the files"
          tone="error"
          findings={problems.map((p) => ({
            severity: "error" as const,
            rule: "apply",
            message: p.message,
            paramId: p.paramId,
            instance: p.instance,
            file: p.file,
          }))}
          onOpenParam={onOpenParam}
        />
      )}
      {errors.length > 0 && (
        <FindingGroup
          title={`${errors.length} problem${errors.length === 1 ? "" : "s"} the data model will not allow`}
          tone="error"
          findings={errors}
          onOpenParam={onOpenParam}
        />
      )}
      {warnings.length > 0 && (
        <FindingGroup
          title={`${warnings.length} thing${warnings.length === 1 ? "" : "s"} worth knowing`}
          subtitle="These do not block the change."
          tone="warn"
          findings={warnings}
          onOpenParam={onOpenParam}
          collapsedByDefault={phase === "submitted"}
        />
      )}

      {run?.skipped?.length ? (
        <details className="cf-vflow-skipped">
          <summary>
            {run.skipped.length} check{run.skipped.length === 1 ? "" : "s"} could not be made here
          </summary>
          <ul>
            {run.skipped.slice(0, 40).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="cf-vflow-actions">
        {phase === "submitted" ? (
          <Button type="primary" onClick={() => outcome && onDone(outcome)}>
            View the change
          </Button>
        ) : (
          <>
            <Button onClick={onCancel} disabled={phase === "validating" || phase === "submitting"}>
              Back to my changes
            </Button>
            {(phase === "failed" || phase === "broken") && (
              <Button icon={<ReloadOutlined />} onClick={() => setAttempt((n) => n + 1)}>
                Check again
              </Button>
            )}
            {phase === "failed" && !showOverride && (
              // An override exists because the alternative is not "no
              // overrides": it is somebody switching the validator off in an
              // environment variable, where no reviewer will ever see it.
              <Tooltip title="The reason you give is written into the change, where the approver reads it">
                <Button danger type="text" onClick={() => setShowOverride(true)}>
                  Submit anyway
                </Button>
              </Tooltip>
            )}
          </>
        )}
      </div>

      {showOverride && phase === "failed" && (
        <div className="cf-vflow-override">
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            This change does not satisfy the data model. Submitting it anyway is recorded in the
            change itself, so the approver sees it before publishing.
          </Typography.Text>
          <Input.TextArea
            rows={2}
            value={overrideReason}
            maxLength={300}
            placeholder="Why is this correct anyway? e.g. lab rig, vendor confirmed the range is wrong"
            onChange={(e) => setOverrideReason(e.target.value)}
          />
          <div className="cf-vflow-actions">
            <Button onClick={() => setShowOverride(false)}>Cancel</Button>
            <Button
              danger
              type="primary"
              disabled={overrideReason.trim().length < 4}
              onClick={() => void doSubmit({ override: true, overrideReason: overrideReason.trim() })}
            >
              Submit over {errors.length + problems.length} objection
              {errors.length + problems.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Shown for the instant between opening and the server's first answer, so the
// road is drawn before anything walks it rather than appearing underneath the
// reader a step at a time.
const PLACEHOLDER_STAGES: ValidationStage[] = [
  { id: "collect", label: "Reading your changes", state: "running" },
  { id: "rules", label: "Checking each value against its rules", state: "pending" },
  { id: "build", label: "Building the files this change would commit", state: "pending" },
  { id: "model", label: "Validating against the data model", state: "pending" },
];

/** The vertical rail: one node per stage, joined by a line the progress
 *  travels down. */
function StageRail({ stages }: { stages: ValidationStage[] }) {
  return (
    <ol className="cf-stages">
      {stages.map((s, i) => (
        <li key={s.id} className={`cf-stage is-${s.state}`}>
          <span className="cf-stage-mark" aria-hidden>
            <StageGlyph state={s.state} />
          </span>
          {i < stages.length - 1 && <span className="cf-stage-line" aria-hidden />}
          <span className="cf-stage-body">
            <span className="cf-stage-label">{s.label}</span>
            {s.detail && <span className="cf-stage-detail">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

// SHAPE says what a node is, not colour alone: a check, a cross, a dash, a
// sweeping arc, a hollow ring. The rail is readable with every hue removed.
function StageGlyph({ state }: { state: ValidationStage["state"] }) {
  switch (state) {
    case "passed":
      return <CheckCircleFilled />;
    case "failed":
      return <CloseCircleFilled />;
    case "skipped":
      return <MinusCircleOutlined />;
    case "running":
      return (
        <svg viewBox="0 0 24 24" className="cf-stage-spin" width="1em" height="1em">
          <circle cx="12" cy="12" r="9" fill="none" strokeWidth="2.5" className="cf-stage-track" />
          <path d="M12 3a9 9 0 0 1 9 9" fill="none" strokeWidth="2.5" strokeLinecap="round"
            className="cf-stage-arc" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="1em" height="1em">
          <circle cx="12" cy="12" r="9" fill="none" strokeWidth="2.5" className="cf-stage-track" />
        </svg>
      );
  }
}

function Verdict({
  phase,
  errors,
  problems,
  warnings,
  outcome,
  error,
}: {
  phase: Phase;
  errors: number;
  problems: number;
  warnings: number;
  outcome: SubmitOutcome | null;
  error: string | null;
}) {
  if (phase === "submitted") {
    return (
      <div className="cf-verdict is-ok">
        <span className="cf-verdict-mark" aria-hidden>
          <CheckCircleFilled />
        </span>
        <div>
          <div className="cf-verdict-head">Changes validated and submitted</div>
          <div className="cf-verdict-sub">
            {outcome ? `CR-${outcome.number ?? outcome.id} is open for review.` : "Open for review."}
            {warnings > 0 && ` ${warnings} note${warnings === 1 ? "" : "s"} below.`}
          </div>
        </div>
      </div>
    );
  }
  if (phase === "broken") {
    return (
      <div className="cf-verdict is-unknown">
        <span className="cf-verdict-mark" aria-hidden>
          <ExclamationCircleFilled />
        </span>
        <div>
          <div className="cf-verdict-head">The change could not be checked</div>
          {/* Not a pass. Nothing was validated, and saying so is the only
              honest answer with a device on the other end of it. */}
          <div className="cf-verdict-sub">
            {error || "Nothing was validated, so nothing was submitted."} Try again in a moment.
          </div>
        </div>
      </div>
    );
  }
  const total = errors + problems;
  return (
    <div className="cf-verdict is-bad">
      <span className="cf-verdict-mark" aria-hidden>
        <CloseCircleFilled />
      </span>
      <div>
        <div className="cf-verdict-head">
          Not submitted - {total} problem{total === 1 ? "" : "s"} to fix
        </div>
        <div className="cf-verdict-sub">
          Nothing has been branched, committed or pushed. Fix these and try again.
        </div>
      </div>
    </div>
  );
}

/** Human wording for the kind of check that produced a finding. The rule names
 *  are the schema language's; these are the reader's. */
const RULE_LABEL: Record<string, string> = {
  type: "Value",
  mandatory: "Missing",
  key: "Identity",
  unique: "Duplicate",
  leafref: "Reference",
  must: "Condition",
  when: "Applies when",
  choice: "Alternatives",
  count: "How many",
  feature: "Not in this release",
  status: "Withdrawn",
  schema: "Model",
  apply: "Could not apply",
};

function FindingGroup({
  title,
  subtitle,
  tone,
  findings,
  onOpenParam,
  collapsedByDefault,
}: {
  title: string;
  subtitle?: string;
  tone: "error" | "warn";
  findings: ValidationFinding[];
  onOpenParam?: (paramId: string) => void;
  collapsedByDefault?: boolean;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  return (
    <section className={`cf-findings is-${tone}`}>
      <button className="cf-findings-head" onClick={() => setOpen((o) => !o)} type="button">
        <RightOutlined className={`cf-findings-caret${open ? " is-open" : ""}`} />
        <span className="cf-findings-title">{title}</span>
        {subtitle && <span className="cf-findings-sub">{subtitle}</span>}
      </button>
      {open && (
        <ul className="cf-findings-list">
          {findings.map((f, i) => (
            <li key={i} className="cf-finding">
              <span className="cf-finding-rule">{RULE_LABEL[f.rule] ?? f.rule}</span>
              <div className="cf-finding-body">
                <div className="cf-finding-msg">{f.message}</div>
                <div className="cf-finding-where">
                  {f.name && <span className="cf-finding-name">{f.name}</span>}
                  {f.instance && <span className="cf-finding-chip">{f.instance}</span>}
                  {f.file && (
                    <span className="cf-finding-file">
                      {f.file}
                      {f.line ? `:${f.line}` : ""}
                    </span>
                  )}
                </div>
                {/* The schema's own expression, for the reader who wants to
                    check the constraint rather than take it on trust. */}
                {f.detail && <div className="cf-finding-detail">{f.detail}</div>}
                {f.schema && <div className="cf-finding-src">stated by {f.schema}</div>}
              </div>
              {f.paramId && onOpenParam && (
                <Button size="small" type="link" onClick={() => onOpenParam(f.paramId!)}>
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
