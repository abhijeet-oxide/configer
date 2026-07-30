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
import { api, type ChangeItem, type ChangeNameCheck, type Instance } from "../api";
import { useUI } from "../store";
import { ChangeItemsTable, itemKey } from "./ChangeItemsTable";
import ChangePreview from "./ChangePreview";
import { useIdentity } from "../identity";

// SubmitChangesButton lives in the editor toolbar (where edits happen, not in
// the global header): pending-edit badge, review-before-submit modal with
// per-row undo, change type + reference, and the git-native explanation.
//
// The dialog has a FIXED shape whatever the size of the draft, and exactly ONE
// thing in it scrolls: the list of changes. Everything else - the production
// notice, the file-diff panel, the form, the buttons - is laid out to fit inside
// the dialog's own height, which is capped to the window.
//
// It took two goes to get here. First the dialog grew with the draft, so a
// hundred edits pushed the form off the bottom of the screen. Then the body
// scrolled, which put THREE bars on screen at once (the body's, the list's, and
// a sideways one under the table) and made the dialog look broken. A dialog is a
// fixed frame around one scrollable list; nothing else in it may scroll.
const BODY_H = "min(700px, calc(100vh - 170px))";

export default function SubmitChangesButton({ instances }: { instances?: Instance[] }) {
  const { message } = AntApp.useApp();
  // Submitting is a change. A viewer can never have a draft to submit, so the
  // action is absent rather than present-and-disabled.
  const { canEdit } = useIdentity();
  const qc = useQueryClient();
  const { setSection, selectParam, openSubmit, setOpenSubmit } = useUI();
  const [open, setOpen] = useState(false);
  const [showDiffs, setShowDiffs] = useState(false);
  const [form] = Form.useForm<{ title: string; description?: string; reference?: string; category?: string }>();
  const titleRef = useRef<InputRef>(null);

  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const items = useMemo(() => draftQ.data?.draft?.items ?? [], [draftQ.data]);
  const pending = items.length;
  const prodTouched = items.some(
    (it) => instances?.find((i) => i.name === it.instance)?.environment === "production",
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
      api.revertValue(it.action === "edit-file" ? `file:${it.file}` : it.paramId, it.instance),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: Error) => message.error(e.message),
    onSettled: () => setUndoing(null),
  });

  const submit = useMutation({
    mutationFn: (v: { title: string; description?: string; reference?: string; category?: string }) =>
      api.submitChange(draftQ.data!.draft!.id, { ...v, author: "Local user" }),
    onSuccess: (cr) => {
      setOpen(false);
      form.resetFields();
      qc.invalidateQueries();
      message.success(
        cr.prUrl
          ? `Submitted for review as CR-${cr.number ?? cr.id}, PR ${cr.prUrl}`
          : `Submitted for review as CR-${cr.number ?? cr.id}`,
        6,
      );
      setSection("changes");
    },
    onError: (e: Error) => message.error(e.message),
  });

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
        title={`Review your changes (${pending})`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        okText="Submit for review"
        // A name another OPEN change already holds is refused by the server
        // too; blocking here means the user finds out while they can still fix
        // it, rather than through a failed submit.
        okButtonProps={{ disabled: pending === 0 || nameCheck?.available === false }}
        confirmLoading={submit.isPending}
        width={760}
        // Pinned near the top and capped to the viewport: the dialog can never
        // be taller than the screen it is on, on a phone or a laptop.
        style={{ top: 24, maxWidth: "calc(100vw - 32px)" }}
        styles={{
          body: {
            height: BODY_H,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            // The parts below add up to less than this on any normal screen, so
            // no bar appears here; auto rather than hidden so a very short window
            // (under ~680px) scrolls instead of clipping the form.
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
        {/* The middle of the dialog holds ONE of two things at a time, and it is
            the only part that scrolls: the list of changes, or the byte-level
            diff of the files they rewrite. Showing both meant neither got enough
            height to be worth reading, and pushed the form off the bottom - and
            they answer the same question at two altitudes, so the reader wants
            one or the other, never a sliver of each. */}
        <div className="cf-fill">
          {showDiffs && draftQ.data?.draft ? (
            <ChangePreview changeId={draftQ.data.draft.id} />
          ) : (
            <ChangeItemsTable
              items={items}
              fill
              onUndo={(it) => {
                setUndoing(itemKey(it));
                revert.mutate(it);
              }}
              undoingKey={undoing}
              onOpenParam={(v) => {
                selectParam(v);
                setSection("config");
                setOpen(false);
              }}
            />
          )}
        </div>

        {pending > 0 && draftQ.data?.draft && (
          <Button
            type="link"
            size="small"
            style={{ paddingLeft: 0, alignSelf: "flex-start", flexShrink: 0 }}
            onClick={() => setShowDiffs((v) => !v)}
          >
            {showDiffs ? "Back to the list of changes" : "View exact file changes"}
          </Button>
        )}
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => submit.mutate(v)}
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
        <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
          On Git this saves your edits to a dedicated review branch (named after this
          change) and opens a review; nothing goes live until an approver publishes it.
        </Typography.Text>
      </Modal>
    </>
  );
}
