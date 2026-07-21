// PasteImportModal brings settings under management from a pasted config blob
// instead of a repository scan: paste YAML/JSON/XML, name the file it belongs
// to, and Configer proposes candidate parameters (via the same analyzer the
// scanner uses). Selected candidates are committed through the ordinary import
// path, so a paste is just an incremental onboarding.
import { useState } from "react";
import { Modal, Input, Table, Tag, Typography, App as AntApp } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AnalyzeCandidate } from "../api";

const candKey = (c: AnalyzeCandidate) => `${c.file}|${c.path}`;

export default function PasteImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [file, setFile] = useState("");
  const [candidates, setCandidates] = useState<AnalyzeCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  const reset = () => {
    setContent("");
    setFile("");
    setCandidates([]);
    setSelected([]);
  };

  const analyze = useMutation({
    mutationFn: () => api.analyzeImport(content, file || undefined),
    onSuccess: (res) => {
      const cands = res.candidates ?? [];
      setCandidates(cands);
      // Pre-select everything not already managed.
      setSelected(cands.filter((c) => !c.managed).map(candKey));
      if (cands.length === 0) message.info("No settings found in the pasted content.");
    },
    onError: (e: Error) => message.error(e.message),
  });

  const doImport = useMutation({
    mutationFn: () => {
      const chosen = candidates.filter((c) => selected.includes(candKey(c)));
      return api.importParameters({
        parameters: chosen.map((c) => ({
          name: c.name,
          type: c.type as never,
          bindings: [{ file: c.file, path: c.path, format: c.format as never }],
        })),
        ignoreFiles: [],
        author: "demo-user",
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries();
      message.success(`Imported ${res.imported} parameter${res.imported === 1 ? "" : "s"} in one commit.`);
      reset();
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Modal
      open={open}
      width={720}
      title="Paste configuration to import"
      onCancel={() => {
        reset();
        onClose();
      }}
      okText={candidates.length ? `Import ${selected.length} selected` : "Analyze"}
      okButtonProps={{
        disabled: candidates.length ? selected.length === 0 : content.trim() === "",
        loading: analyze.isPending || doImport.isPending,
      }}
      onOk={() => (candidates.length ? doImport.mutate() : analyze.mutate())}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        Paste a YAML, JSON, or XML config and name the repository file it belongs to (so the values
        can be written back there). Configer proposes the settings it finds; pick the ones to manage.
      </Typography.Paragraph>
      <Input
        placeholder="Target file, e.g. instances/prod/values.yaml"
        value={file}
        onChange={(e) => setFile(e.target.value)}
        className="mono"
        style={{ marginBottom: 8 }}
      />
      <Input.TextArea
        placeholder={"cache:\n  ttlSeconds: 30\n  host: redis.local"}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          if (candidates.length) setCandidates([]); // re-analyze after an edit
        }}
        rows={8}
        className="mono"
        style={{ fontSize: 12.5 }}
      />

      {candidates.length > 0 && (
        <Table<AnalyzeCandidate>
          size="small"
          style={{ marginTop: 12 }}
          rowKey={candKey}
          dataSource={candidates}
          pagination={false}
          scroll={{ y: 260 }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
            getCheckboxProps: (c) => ({ disabled: c.managed }),
          }}
          columns={[
            {
              title: "Setting",
              dataIndex: "name",
              render: (n: string, c) => (
                <span>
                  <span className="mono" style={{ fontSize: 12.5 }}>{n}</span>
                  {c.managed && <Tag style={{ marginLeft: 6 }}>already managed</Tag>}
                </span>
              ),
            },
            { title: "Type", dataIndex: "type", width: 90, render: (t: string) => <Tag>{t || "string"}</Tag> },
            {
              title: "Value",
              dataIndex: "value",
              width: 200,
              ellipsis: true,
              render: (v: unknown) => <code style={{ fontSize: 12 }}>{JSON.stringify(v)}</code>,
            },
          ]}
        />
      )}
    </Modal>
  );
}
