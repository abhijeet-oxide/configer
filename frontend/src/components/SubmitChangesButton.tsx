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
import { useEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepoQuery } from "../repoQuery";
import { api, type ChangeItem, type ChangeNameCheck, type Instance } from "../api";
import { useUI } from "../store";
import { ChangeItemsTable } from "./ChangeItemsTable";
import ChangePreview from "./ChangePreview";
import { useIdentity } from "../identity";

// SubmitChangesButton lives in the editor toolbar (where edits happen, not in
// the global header): pending-edit badge, review-before-submit modal with
// per-row undo, change type + reference, and the git-native explanation.

export default function SubmitChangesButton({ instances }: { instances?: Instance[] }) {
  const { message } = AntApp.useApp();
  // Submitting is a change. A viewer can never have a draft to submit, so the
  // action is absent rather than present-and-disabled.
  const { canEdit } = useIdentity();
  const qc = useQueryClient();
  const { setSection, selectParam } = useUI();
  const [open, setOpen] = useState(false);
  const [showDiffs, setShowDiffs] = useState(false);
  const [form] = Form.useForm<{ title: string; description?: string; reference?: string; category?: string }>();
  const titleRef = useRef<InputRef>(null);

  const draftQ = useRepoQuery({ queryKey: ["draft"], queryFn: api.draft, refetchInterval: 15_000 });
  const items = draftQ.data?.draft?.items ?? [];
  const pending = items.length;
  const prodTouched = items.some(
    (it) => instances?.find((i) => i.name === it.instance)?.environment === "production",
  );

  // The title becomes the branch, and the branch is what every reviewer and CI
  // run sees from then on. So the name is checked WHILE it is typed: a clash
  // with a change that is still open is worth knowing before submitting, not
  // after a submit that gets refused.
  const [title, setTitle] = useState("");
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
        .checkChangeName(t, draftId)
        .then(setNameCheck)
        // A name check that cannot run must never block submitting. The server
        // refuses a real clash anyway; this is the early warning, not the gate.
        .catch(() => setNameCheck(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [title, draftId, open]);

  const revert = useMutation({
    mutationFn: (it: ChangeItem) =>
      api.revertValue(it.action === "edit-file" ? `file:${it.file}` : it.paramId, it.instance),
    onSuccess: () => qc.invalidateQueries(),
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
          ? `Submitted for review as CR-${cr.id}, PR ${cr.prUrl}`
          : `Submitted for review as CR-${cr.id}`,
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
        afterOpenChange={(o) => o && titleRef.current?.focus()}
      >
        {prodTouched && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
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
        <div style={{ marginBottom: 14 }}>
          <ChangeItemsTable
            items={items}
            onUndo={(it) => revert.mutate(it)}
            undoLoading={revert.isPending}
            onOpenParam={(v) => {
              selectParam(v);
              setSection("config");
              setOpen(false);
            }}
          />
        </div>

        {pending > 0 && draftQ.data?.draft && (
          <div style={{ marginBottom: 14 }}>
            <Button
              type="link"
              size="small"
              style={{ paddingLeft: 0 }}
              onClick={() => setShowDiffs((v) => !v)}
            >
              {showDiffs ? "Hide file diffs" : "View exact file changes"}
            </Button>
            {showDiffs && <ChangePreview changeId={draftQ.data.draft.id} />}
          </div>
        )}
        <Form form={form} layout="vertical" onFinish={(v) => submit.mutate(v)} initialValues={{ title: "" }}>
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
                // What the name will become, in the words git will use.
                <span>
                  Saved to branch <code>{nameCheck.branch}</code>
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
            <Form.Item name="category" label="Change type" initialValue="feature" style={{ flex: 1 }}>
              <Select
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
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          On Git this saves your edits to a dedicated review branch (named after this
          change) and opens a review; nothing goes live until an approver publishes it.
        </Typography.Text>
      </Modal>
    </>
  );
}
