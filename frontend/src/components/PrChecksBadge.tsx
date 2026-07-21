// PrChecksBadge shows a change request's live CI status and merge-readiness,
// read fresh from the host. It renders nothing for pure-git deployments or a
// change with no hosted pull request, so it is safe to drop beside any CR row.
import { Tag, Tooltip } from "antd";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { CheckCircleOutlined, CloseCircleOutlined, SyncOutlined } from "../icons";

// A pull request whose host merge-readiness is one of these cannot merge yet;
// the tooltip explains why so a reviewer is not left guessing.
const blockedReason: Record<string, string> = {
  blocked: "Merging is blocked by branch protection (reviews or checks required)",
  dirty: "The branch has conflicts with its base",
  behind: "The branch is behind its base and must be updated",
  draft: "The pull request is still a draft",
  unstable: "Some non-required checks are failing",
};

function checkTag(checks: string) {
  if (checks === "passing")
    return <Tag color="success" icon={<CheckCircleOutlined />}>Checks passing</Tag>;
  if (checks === "failing")
    return <Tag color="error" icon={<CloseCircleOutlined />}>Checks failing</Tag>;
  if (checks === "pending")
    return <Tag color="processing" icon={<SyncOutlined />}>Checks running</Tag>;
  return null; // "none": no CI configured, show nothing
}

export default function PrChecksBadge({ changeId, hasPr }: { changeId: number; hasPr: boolean }) {
  const q = useQuery({
    queryKey: ["pr-status", changeId],
    queryFn: () => api.prStatus(changeId),
    enabled: hasPr,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const pr = q.data?.pr;
  if (!q.data?.supported || !pr) return null;

  const reason = pr.mergeable ? blockedReason[pr.mergeable] : undefined;

  return (
    <>
      {checkTag(pr.checks ?? "none")}
      {pr.mergeable === "clean" && !pr.merged && (
        <Tag color="green">Ready to merge</Tag>
      )}
      {reason && (
        <Tooltip title={reason}>
          <Tag color="warning">Not mergeable</Tag>
        </Tooltip>
      )}
    </>
  );
}
