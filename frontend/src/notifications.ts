// The notification log: what the app has told this person, kept so it can be
// read again.
//
// Toasts disappear, and until now that was the end of them - a message that
// scrolled past while the user was reading something else was simply gone, and
// the bell led to the approvals inbox, which is a different thing entirely.
// Every notification the app raises is recorded here (newest first, bounded),
// and the bell opens THIS list.
//
// It lives in the browser only: it is a record of what was shown on this
// device, not an audit trail. The audit trail (who did what, kept by the
// service) is a separate, authoritative surface.
import { create } from "zustand";

export type NoteKind = "error" | "warning" | "success" | "info";

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  detail?: string;
  /** the service's correlation id, when the notification came from a failure */
  requestId?: string;
  /** epoch millis */
  at: number;
  read: boolean;
}

const MAX = 100;
const KEY = "configer.notifications";

function load(): Note[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Note[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return []; // a corrupted log is not worth an error: start a fresh one
  }
}

function save(notes: Note[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes.slice(0, MAX)));
  } catch {
    // storage full or blocked: the in-memory log still works for this session
  }
}

interface NotificationState {
  notes: Note[];
  unread: number;
  /** record one notification; returns nothing - callers still show the toast */
  add: (n: Omit<Note, "id" | "at" | "read">) => void;
  markAllRead: () => void;
  clear: () => void;
}

const initial = load();

export const useNotifications = create<NotificationState>((set, get) => ({
  notes: initial,
  unread: initial.filter((n) => !n.read).length,
  add: (n) => {
    const note: Note = {
      ...n,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      read: false,
    };
    // Identical back-to-back notifications (a poll failing every few seconds)
    // collapse onto the newest entry rather than filling the log with copies.
    const head = get().notes[0];
    const notes =
      head && head.title === note.title && head.detail === note.detail && note.at - head.at < 60_000
        ? [note, ...get().notes.slice(1)]
        : [note, ...get().notes].slice(0, MAX);
    save(notes);
    set({ notes, unread: notes.filter((x) => !x.read).length });
  },
  markAllRead: () => {
    const notes = get().notes.map((n) => (n.read ? n : { ...n, read: true }));
    save(notes);
    set({ notes, unread: 0 });
  },
  clear: () => {
    save([]);
    set({ notes: [], unread: 0 });
  },
}));

/** Record a notification from outside React (see notify.ts). */
export function recordNote(n: Omit<Note, "id" | "at" | "read">) {
  useNotifications.getState().add(n);
}
