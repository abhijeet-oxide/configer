import {
  Badge,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Typography,
  App as AntApp,
} from "antd";
import { PullRequestOutlined, WarningFilled } from "../icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { InputRef } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, revertRef, reviewItems, type ChangeItem, type ChangeNameCheck, type Instance } from "../api";
import { useUI } from "../store";
import { isProductionEnv } from "../theme";
import { ChangeItemsTable, itemKey } from "./ChangeItemsTable";
import ValidationFlow from "./ValidationFlow";
import { useIdentity } from "../identity";

// SubmitChangesButton lives in the editor toolbar (where edits happen, not in
// the global header): pending-edit badge, review-before-submit modal with
// per-row undo, change type + reference, and the git-native explanation.
//
// Exactly ONE thing in the dialog scrolls: the list of changes. Everything else
// - the production notice, the form, the buttons - is laid out to fit, and the
// whole dialog is capped to the window.
//
// The cap is a MAXIMUM, not a height. Pinning the body to 700px meant a draft of
// one edit was reviewed through a dialog three quarters of it empty - a screen
// of nothing between the single row and the form under it. So the list is as
// tall as its rows, the dialog is as tall as its contents, and only once there
// is more than fits does the list start scrolling inside the cap. One edit gets
// a small dialog; a hundred get the same dialog the old one always was.
const BODY_MAX_H = "min(700px, calc(100vh - 170px))";

/** How many staged edits go back in one request. Big enough that undoing a
 *  hundred is two or three round trips, small enough that the progress it
 *  reports moves while the user is watching. */
const UNDO_BATCH = 40;

export default function SubmitChangesButton({ instances }: { instances?: Instance[] }) {
  const { message } = AntApp.useApp();
  // Submitting is a change. A viewer can never have a draft to submit, so the
  // action is absent rather than present-and-disabled.
  const { canEdit } = useIdentity();
  const qc = useQueryClient();
  const { setSection, selectParam, openSubmit, setOpenSubmit, setFileFocus } = useUI();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ title: string; description?: string; reference?: string; category?: string }>();
  const titleRef = useRef<InputRef>(null);

  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft });
  // What this deployment can actually check. Read once, so the dialog can
  // promise a model check only where there is a model to check against - "your
  // change is valid" and "nothing looked at your change" must never read the
  // same.
  const vstatusQ = useRepoQuery({ queryKey: ["validation-status"], queryFn: api.validationStatus });
  const vstatus = vstatusQ.data;
  const items = useMemo(() => draftQ.data?.draft?.items ?? [], [draftQ.data]);
  // Counted the way the list is COUNTED: a file row the parameter rows already
  // explain is not shown, so counting it would make the button promise one more
  // change than the dialog can show.
  const pending = reviewItems(items).length;
  const prodTouched = items.some((it) =>
    isProductionEnv(instances?.find((i) => i.name === it.instance)?.environment),
  );

  // Arriving from "Review & submit" in the Changes list: open straight onto the
  // dialog they asked for, and consume the handoff so a later visit does not
  // reopen it.
  useEffect(() => {
    if (openSubmit && pending > 0) {
      setOpen(true);
      setOpenSubmit(false);
    } else if (openSubmit && !draftQ.isLoading) {
      setOpenSubmit(false);
    }
  }, [openSubmit, pending, draftQ.isLoading, setOpenSubmit]);

  // What KIND of change this is, guessed from what it actually does. A draft
  // that only renames a region or moves an instance to a new version is not a
  // feature, and defaulting it to one asks the user to correct the form every
  // time they touch instance settings.
  const suggestedCategory = useMemo(() => {
    if (!pending) return "feature";
    const structural = items.every((it) =>
      it.action === "update-instance" || it.action === "add-instance" || it.action === "remove-instance",
    );
    return structural ? "maintenance" : "feature";
  }, [items, pending]);

  // The title becomes the branch, and the branch is what every reviewer and CI
  // run sees from then on. So the name is checked WHILE it is typed: a clash
  // with a change that is still open is worth knowing before submitting, not
  // after a submit that gets refused.
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("feature");
  const [nameCheck, setNameCheck] = useState<ChangeNameCheck | null>(null);
  const draftId = draftQ.data?.draft?.id;
  useEffect(() => {
    const t = title.trim();
    if (!open || !t) {
      setNameCheck(null);
      return;
    }
    // Debounced: one request per pause, not one per keystroke.
    const timer = setTimeout(() => {
      api
        .checkChangeName(t, draftId, category)
        .then(setNameCheck)
        // A name check that cannot run must never block submitting. The server
        // refuses a real clash anyway; this is the early warning, not the gate.
        .catch(() => setNameCheck(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [title, draftId, category, open]);

  // Which row's undo is in flight. A single boolean here put every delete
  // button in the list into a spinner at once; the identity of the row is what
  // the table needs to show one busy and the rest merely unavailable.
  const [undoing, setUndoing] = useState<string | null>(null);
  const revert = useMutation({
    mutationFn: (it: ChangeItem) =>
      (({ paramId, instance, action }) => api.revertValue(paramId, instance, action))(revertRef(it)),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: Error) => message.error(e.message),
    onSettled: () => setUndoing(null),
  });

  // Undoing a selection: one request per BATCH, not per item. The draft store
  // is a read-modify-write behind a per-owner lock, so ninety single deletes
  // queued up behind each other for long enough that the dialog looked hung and
  // the changes drained away after it was closed. Batching also gives the one
  // honest thing to show while it runs - how many are done - and the list is
  // trimmed as each batch lands, so the work is visible where it happens.
  const [undoProgress, setUndoProgress] = useState<{ done: number; total: number } | null>(null);
  const revertMany = useMutation({
    mutationFn: async (its: ChangeItem[]) => {
      setUndoProgress({ done: 0, total: its.length });
      for (let i = 0; i < its.length; i += UNDO_BATCH) {
        const batch = its.slice(i, i + UNDO_BATCH);
        await api.revertValues(
          batch.map(revertRef),
        );
        // Take the batch out of the list the moment the server has it, rather
        // than leaving a hundred rows standing until the very end.
        const gone = new Set(batch.map(itemKey));
        qc.setQueryData<{ draft: { items: ChangeItem[] } | null }>(["draft"], (prev) =>
          prev?.draft
            ? { ...prev, draft: { ...prev.draft, items: prev.draft.items.filter((x) => !gone.has(itemKey(x))) } }
            : prev,
        );
        setUndoProgress({ done: Math.min(i + batch.length, its.length), total: its.length });
      }
    },
    onSuccess: (_r, its) => {
      message.success(`Undid ${its.length} change${its.length === 1 ? "" : "s"}`);
    },
    onError: (e: Error) => message.error(e.message),
    onSettled: () => {
      setUndoProgress(null);
      qc.invalidateQueries();
    },
  });

  // Submitting is not one call any more: the change is VALIDATED first, and
  // the validation is something the user watches happen rather than a spinner
  // they wait out. So the dialog has two faces - the review list with its form,
  // and the flow - and the form's details are held here for the flow to use.
  const [flowFor, setFlowFor] = useState<{
    id: number;
    values: { title: string; description?: string; reference?: string; category?: string };
  } | null>(null);

  // Undoing the last staged change leaves nothing to review, so the dialog
  // closes itself rather than sitting over an empty list with a form asking
  // what the change is about. While the flow is up there IS nothing staged -
  // the change has been submitted - so the rule is suspended there.
  const nothingLeft = open && pending === 0 && !flowFor && !revertMany.isPending;
  useEffect(() => {
    if (nothingLeft) setOpen(false);
  }, [nothingLeft]);

  const closeDialog = () => {
    setOpen(false);
    setFlowFor(null);
  };

  if (!canEdit) return null;

  return (
    <>
      {/* Pending changes are "pending" everywhere in the product: amber, not red. */}
      <Badge count={pending} size="small" offset={[-4, 0]} color="var(--c-pending)">
        <Button
          size="small"
          type="primary"
          icon={<PullRequestOutlined />}
          disabled={pending === 0}
          onClick={() => setOpen(true)}
        >
          {pending > 0 ? `Review ${pending} change${pending === 1 ? "" : "s"}` : "Review changes"}
        </Button>
      </Badge>

      <Modal
        title={flowFor ? "Validating and submitting" : `Review your changes (${pending})`}
        open={open}
        onCancel={closeDialog}
        onOk={() => form.submit()}
        okText="Validate & submit"
        // A name another OPEN change already holds is refused by the server
        // too; blocking here means the user finds out while they can still fix
        // it, rather than through a failed submit.
        okButtonProps={{ disabled: pending === 0 || nameCheck?.available === false }}
        // The flow carries its own buttons, because what they say depends on
        // what the validation found - and closing it mid-check would leave the
        // user with no idea whether anything was submitted.
        maskClosable={!flowFor}
        closable={!flowFor}
        keyboard={!flowFor}
        // The sentence that explains the buttons sits WITH the buttons, not in
        // the body: it is fixed text, and every line of it in the body is a line
        // the list of changes does not get.
        footer={
          flowFor
            ? null
            : (buttons) => (
                <div className="cf-submit-foot">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {/* What is about to happen, in the terms it will happen in.
                        "Checked against the data model" is a promise, so it is
                        only made where a model exists to check against. */}
                    {vstatus?.schemaDetected && vstatus.available
                      ? `Checked against ${vstatus.modules} data model${vstatus.modules === 1 ? "" : "s"} first, then saved to a review branch; nothing goes live until an approver publishes it.`
                      : "Checked against the rules in the catalogue, then saved to a review branch; nothing goes live until an approver publishes it."}
                  </Typography.Text>
                  <span className="cf-submit-foot-actions">{buttons}</span>
                </div>
              )
        }
        width={760}
        // Pinned near the top and capped to the viewport: the dialog can never
        // be taller than the screen it is on, on a phone or a laptop.
        style={{ top: 24, maxWidth: "calc(100vw - 32px)" }}
        styles={{
          body: {
            maxHeight: BODY_MAX_H,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            // The list is the only part allowed to shrink, so it absorbs
            // everything over the cap; auto rather than hidden so a very short
            // window (under ~680px) scrolls instead of clipping the form.
            overflowY: "auto",
            overflowX: "hidden",
          },
        }}
        afterOpenChange={(o) => {
          if (!o) return;
          titleRef.current?.focus();
          // Offer the change type that matches what the draft actually does,
          // every time it opens - the draft can have changed since last time.
          form.setFieldValue("category", suggestedCategory);
          setCategory(suggestedCategory);
        }}
      >
        {/* Once the flow is up, the review list has done its job: what matters
            is what the check is finding. Two screens in one dialog rather than
            a second window, so "did that go through?" is never answered by a
            dialog that closed itself. */}
        {flowFor ? (
          <ValidationFlow
            changeId={flowFor.id}
            submit={(opts) =>
              api.submitChange(flowFor.id, { ...flowFor.values, author: "Local user", ...opts })
            }
            onDone={(cr) => {
              closeDialog();
              form.resetFields();
              qc.invalidateQueries();
              if (cr.prUrl) message.success(`CR-${cr.number ?? cr.id} opened: ${cr.prUrl}`, 6);
              setSection("changes");
            }}
            onCancel={() => {
              // Back to the list with the form intact: whatever needs fixing is
              // a cell in the grid, and retyping the title to get there is a
              // punishment for having run the check.
              setFlowFor(null);
              qc.invalidateQueries();
            }}
            onOpenParam={(paramId) => {
              selectParam(paramId);
              setSection("config");
              closeDialog();
            }}
            onOpenFile={(file, line, instance) => {
              // A finding names a place. Landing on the file at the line is the
              // difference between being told what is wrong and being taken to
              // it - a schema file included, since "stated by" is only evidence
              // if the reader can go and read it.
              setFileFocus({ path: file, line, instance, allInstances: !instance });
              setSection("files");
              closeDialog();
            }}
          />
        ) : (
          <>
        {prodTouched && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12.5,
              background: "var(--c-pending-bg)",
              border: "1px solid var(--c-pending-bd)",
            }}
          >
            <WarningFilled style={{ color: "var(--c-pending)", fontSize: 14, flexShrink: 0 }} />
            <span>
              <span style={{ fontWeight: 600, color: "var(--text)" }}>Touches production.</span>{" "}
              <span style={{ color: "var(--text-2)" }}>Goes live only after an approver publishes.</span>
            </span>
          </div>
        )}
        {/* The list of changes: the one thing in this dialog that scrolls, and
            searchable, sortable and multi-selectable because at a hundred rows
            "find the one I got wrong and undo it" is the actual task. */}
        <div className="cf-fill">
          <ChangeItemsTable
            items={items}
            fill
            onUndo={(it) => {
              setUndoing(itemKey(it));
              revert.mutate(it);
            }}
            onUndoMany={(its) => revertMany.mutate(its)}
            undoingKey={undoing}
            bulkBusy={revertMany.isPending}
            bulkProgress={undoProgress}
            onOpenParam={(v) => {
              selectParam(v);
              setSection("config");
              setOpen(false);
            }}
          />
        </div>

        {/* No byte-level diff from here. Reviewing a change means reading what
            moved, which is the list above; the exact file bytes are the Files
            section's job, and offering them again in a second window only made
            this dialog a fork in the road. */}
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => {
            const id = draftQ.data?.draft?.id;
            if (id) setFlowFor({ id, values: v });
          }}
          initialValues={{ title: "" }}
          style={{ flexShrink: 0 }}
        >
          <Form.Item
            name="title"
            label="What is this change about?"
            rules={[{ required: true, message: "Give the change a short title" }]}
            // The name check is advice, not a form rule: it is about the state
            // of the workspace rather than the shape of the field, and it can
            // change between typing and submitting.
            validateStatus={nameCheck && !nameCheck.available ? "error" : undefined}
            help={
              nameCheck?.message ? (
                <span>{nameCheck.message}</span>
              ) : nameCheck?.branch ? (
                // What the name will become, in the words git will use - and
                // that it does not exist yet, so nobody expects to find it.
                <span>
                  Will create branch <code>{nameCheck.branch}</code> when you submit
                </span>
              ) : undefined
            }
          >
            <Input
              ref={titleRef}
              placeholder="e.g. Update staging DNS servers"
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Form.Item>
          <div style={{ display: "flex", gap: 10 }}>
            <Form.Item name="category" label="Change type" style={{ flex: 1 }}>
              <Select
                onChange={(v) => setCategory(v)}
                options={[
                  { value: "hotfix", label: "Hotfix (urgent fix)" },
                  { value: "feature", label: "Feature (new capability)" },
                  { value: "bugfix", label: "Bugfix" },
                  { value: "maintenance", label: "Maintenance" },
                  { value: "security", label: "Security" },
                  { value: "other", label: "Other" },
                ]}
              />
            </Form.Item>
            <Form.Item name="reference" label="Reference / CR ID (optional)" style={{ flex: 1 }}>
              <Input placeholder="e.g. JIRA-123, CRQ000042" maxLength={60} />
            </Form.Item>
          </div>
          <Form.Item name="description" label="Why is it needed? (optional)">
            <Input.TextArea rows={2} placeholder="Shown to the approver, and kept in the Git history" />
          </Form.Item>
        </Form>
          </>
        )}
      </Modal>
    </>
  );
}
