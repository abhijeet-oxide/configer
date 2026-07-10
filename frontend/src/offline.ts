// Offline resilience: connection state, local snapshots, and an edit queue.
//
// The service being temporarily unreachable must never be disruptive: the UI
// keeps rendering from the last saved snapshot, value edits are stored on the
// device, and everything syncs automatically when the connection returns.
import { create } from "zustand";

export class OfflineError extends Error {
  constructor() {
    super("The Configer service is unreachable");
    this.name = "OfflineError";
  }
}

export interface QueuedEdit {
  instance: string;
  paramId: string;
  value?: unknown;
  action?: string;
  author?: string;
  ts: number;
}

const QKEY = "configer.offlineQueue";

function readQueue(): QueuedEdit[] {
  try {
    return JSON.parse(localStorage.getItem(QKEY) ?? "[]") as QueuedEdit[];
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedEdit[]) {
  try {
    localStorage.setItem(QKEY, JSON.stringify(q));
  } catch {
    // storage full/blocked: the edit still applied optimistically in the UI
  }
  useConn.getState().setQueued(q.length);
}

interface ConnState {
  online: boolean;
  queued: number;
  syncing: boolean;
  setOnline: (b: boolean) => void;
  setQueued: (n: number) => void;
  setSyncing: (b: boolean) => void;
}

export const useConn = create<ConnState>((set) => ({
  online: true,
  queued: readQueue().length,
  syncing: false,
  setOnline: (online) => set({ online }),
  setQueued: (queued) => set({ queued }),
  setSyncing: (syncing) => set({ syncing }),
}));

export function markOnline() {
  if (!useConn.getState().online) useConn.getState().setOnline(true);
}
export function markOffline() {
  if (useConn.getState().online) useConn.getState().setOnline(false);
}

// --- snapshots ---------------------------------------------------------

export function saveSnapshot(key: string, data: unknown) {
  try {
    localStorage.setItem(`configer.snap.${key}`, JSON.stringify({ t: Date.now(), data }));
  } catch {
    // best effort
  }
}

export function loadSnapshot<T>(key: string): { t: number; data: T } | null {
  try {
    const raw = localStorage.getItem(`configer.snap.${key}`);
    return raw ? (JSON.parse(raw) as { t: number; data: T }) : null;
  } catch {
    return null;
  }
}

// --- edit queue --------------------------------------------------------

export function enqueueEdit(e: Omit<QueuedEdit, "ts">) {
  const q = readQueue();
  // last write per cell wins
  const rest = q.filter((x) => !(x.paramId === e.paramId && x.instance === e.instance));
  rest.push({ ...e, ts: Date.now() });
  writeQueue(rest);
}

export function drainQueue(): QueuedEdit[] {
  const q = readQueue();
  writeQueue([]);
  return q;
}

export function requeue(edits: QueuedEdit[]) {
  writeQueue([...edits, ...readQueue()]);
}

export function queuedEdits(): QueuedEdit[] {
  return readQueue();
}
