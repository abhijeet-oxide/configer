import { Badge, Button, Popover, Tooltip, Typography } from "antd";
import { useState } from "react";
import {
  BellOutlined,
  CheckCircleFilled,
  InboxOutlined,
  InfoCircleOutlined,
  WarningFilled,
  CloseCircleFilled,
} from "../icons";
import { useNotifications, type Note } from "../notifications";
import { useUI } from "../store";
import { relTime } from "./DashboardView";
import { EmptyState } from "./ui";

// The bell, and what is behind it.
//
// The bell used to jump to the approvals inbox, which meant the app had no
// place at all to see a message again once its toast had gone: an error that
// appeared while the user was reading something else was simply lost. Now the
// bell opens the notification log - what this app has told you, newest first -
// and the inbox (work waiting for a person) is one click away from inside it,
// named as what it is.

function toneIcon(kind: Note["kind"]) {
  if (kind === "error") return <CloseCircleFilled style={{ color: "var(--c-danger)" }} />;
  if (kind === "warning") return <WarningFilled style={{ color: "var(--c-pending)" }} />;
  if (kind === "success") return <CheckCircleFilled style={{ color: "var(--c-ok)" }} />;
  return <InfoCircleOutlined style={{ color: "var(--c-review)" }} />;
}

export default function NotificationsPanel({ awaiting }: { awaiting: number }) {
  const [open, setOpen] = useState(false);
  const setSection = useUI((s) => s.setSection);
  const notes = useNotifications((s) => s.notes);
  const unread = useNotifications((s) => s.unread);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clear = useNotifications((s) => s.clear);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) markAllRead();
  };

  const content = (
    <div className="notif-panel">
      <div className="notif-head">
        <span className="notif-title">Notifications</span>
        {notes.length > 0 && (
          <Button type="link" size="small" onClick={clear} style={{ paddingInline: 0 }}>
            Clear
          </Button>
        )}
      </div>
      <div className="notif-list">
        {notes.length === 0 ? (
          <EmptyState
            icon={<BellOutlined />}
            title="Nothing to report"
            hint="Messages the app shows you are kept here, so you can read one again after it disappears."
          />
        ) : (
          notes.map((n) => (
            <div key={n.id} className="notif-item">
              <span className="notif-icon">{toneIcon(n.kind)}</span>
              <div className="notif-body">
                <div className="notif-item-title">{n.title}</div>
                {n.detail && (
                  <Typography.Paragraph
                    type="secondary"
                    className="notif-detail"
                    ellipsis={{ rows: 3, expandable: true, symbol: "more" }}
                  >
                    {n.detail}
                  </Typography.Paragraph>
                )}
                <div className="notif-meta">
                  {relTime(new Date(n.at).toISOString())}
                  {n.requestId ? ` · ref ${n.requestId}` : ""}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="notif-foot">
        <Button
          type="link"
          size="small"
          icon={<InboxOutlined />}
          style={{ paddingInline: 0 }}
          onClick={() => {
            setOpen(false);
            setSection("inbox");
          }}
        >
          {awaiting > 0
            ? `Inbox - ${awaiting} change${awaiting === 1 ? "" : "s"} waiting for review`
            : "Inbox - nothing waiting for review"}
        </Button>
      </div>
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger="click"
      placement="bottomRight"
      content={content}
      styles={{ body: { padding: 0 } }}
    >
      <Tooltip title="Notifications" placement="bottom">
        {/* Unread notifications count on the bell; work waiting for a person is
            the inbox's own number, shown inside. */}
        <Badge count={unread} size="small" color="var(--c-danger)">
          <Button size="small" type="text" icon={<BellOutlined />} aria-label="Notifications" />
        </Badge>
      </Tooltip>
    </Popover>
  );
}
