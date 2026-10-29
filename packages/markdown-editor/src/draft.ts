// Drafts: the text as you type it, kept in this browser so a crash, a closed
// tab or a reload doesn't lose it, like EasyMDE's autosave. The host's own save
// is still the real one; once it has saved, it clears the draft.

export type DraftOptions = {
  /** Names this document's draft; one per document ("project-42", "post-new"). */
  key: string;
  /** How long typing has to pause before the draft is written. Defaults to 1 second. */
  delayMs?: number;
};

export type StoredDraft = { text: string; savedAt: number };

export type DraftState = { status: "off" | "clean" | "pending" | "saved" | "unavailable"; savedAt: number | null };

const PREFIX = "markdown-editor.draft.";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readDraft(key: string): StoredDraft | null {
  try {
    const raw = JSON.parse(storage()?.getItem(PREFIX + key) ?? "null") as Partial<StoredDraft> | null;
    return raw && typeof raw.text === "string" && typeof raw.savedAt === "number" ? { text: raw.text, savedAt: raw.savedAt } : null;
  } catch {
    return null;
  }
}

/** False when the browser won't keep it (private mode, or full). */
export function writeDraft(key: string, text: string, now = Date.now()): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(PREFIX + key, JSON.stringify({ text, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  try {
    storage()?.removeItem(PREFIX + key);
  } catch {
    /* private mode */
  }
}

/** A draft worth offering back: one whose text differs from what the document opened with. */
export function recoverableDraft(key: string, doc: string): StoredDraft | null {
  const draft = readDraft(key);
  if (!draft) return null;
  if (draft.text === doc) {
    clearDraft(key);
    return null;
  }
  return draft;
}

/**
 * Writes the draft a moment after typing stops, and straight away when the
 * page is hidden or closed. `paused` holds off while a recovered draft is
 * still on offer, so typing first doesn't overwrite it.
 */
export class DraftKeeper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: string | null = null;
  private state: DraftState = { status: "clean", savedAt: null };
  paused = false;

  constructor(
    private options: DraftOptions,
    private onState: (state: DraftState) => void = () => {},
  ) {}

  get current(): DraftState {
    return this.state;
  }

  private set(state: DraftState) {
    this.state = state;
    this.onState(state);
  }

  changed(text: string) {
    this.latest = text;
    if (this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.options.delayMs ?? 1000);
    if (this.state.status !== "pending") this.set({ status: "pending", savedAt: this.state.savedAt });
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.latest === null || this.paused) return;
    const now = Date.now();
    this.set(writeDraft(this.options.key, this.latest, now) ? { status: "saved", savedAt: now } : { status: "unavailable", savedAt: null });
    this.latest = null;
  }

  /** The host saved: the draft has done its job. */
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
    clearDraft(this.options.key);
    this.set({ status: "clean", savedAt: null });
  }

  dispose() {
    this.flush();
  }
}
