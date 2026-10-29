// What this browser can do for speech, and the settings remembered on this device.

/** The bits of the Web Speech recogniser we use; TypeScript's DOM types leave it out. */
export interface Recognizer extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognizerClass = new () => Recognizer;

export function recognizerClass(): RecognizerClass | null {
  const w = window as unknown as { SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Why dictation can't run here, or null when it can. The microphone needs a
 * secure page (https or localhost), which a home server on plain http isn't.
 */
export function dictationBlocked(): "unsupported" | "insecure" | null {
  if (!recognizerClass()) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return null;
}

export const canReadAloud = () => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

/** The system's own dictation, for browsers without speech recognition. */
export function osDictationHint(ua = navigator.userAgent): string {
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return "Tap the microphone on your keyboard to dictate instead.";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Press the Fn key twice, or the dictation key, to use your Mac's dictation instead.";
  if (/Windows/i.test(ua)) return "Press Windows+H to use Windows voice typing instead.";
  return "Your system's own dictation, if it has one, works in the editor too.";
}

export const DICTATION_LANGUAGES: { code: string; label: string }[] = [
  { code: "en-GB", label: "English (UK)" },
  { code: "en-US", label: "English (US)" },
  { code: "en-AU", label: "English (Australia)" },
  { code: "en-CA", label: "English (Canada)" },
  { code: "en-IE", label: "English (Ireland)" },
  { code: "en-IN", label: "English (India)" },
  { code: "de-DE", label: "Deutsch" },
  { code: "es-ES", label: "Español" },
  { code: "fr-FR", label: "Français" },
  { code: "it-IT", label: "Italiano" },
  { code: "nl-NL", label: "Nederlands" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "pt-PT", label: "Português (Portugal)" },
  { code: "pl-PL", label: "Polski" },
  { code: "sv-SE", label: "Svenska" },
  { code: "ja-JP", label: "日本語" },
  { code: "zh-CN", label: "中文 (简体)" },
];

const LANG_KEY = "notes.dictation.lang";
const READ_KEY = "notes.readAloud";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** The language last picked for dictation, or the browser's own. */
export function dictationLanguage(): string {
  return read(LANG_KEY) || navigator.language || "en-GB";
}

export const rememberDictationLanguage = (code: string) => write(LANG_KEY, code);

export type ReadSettings = { voice: string | null; rate: number };

export function readSettings(): ReadSettings {
  try {
    const raw = JSON.parse(read(READ_KEY) ?? "{}") as Partial<ReadSettings>;
    const rate = typeof raw.rate === "number" && raw.rate >= 0.5 && raw.rate <= 2 ? raw.rate : 1;
    return { voice: typeof raw.voice === "string" ? raw.voice : null, rate };
  } catch {
    return { voice: null, rate: 1 };
  }
}

export const rememberReadSettings = (s: ReadSettings) => write(READ_KEY, JSON.stringify(s));

/** True for Ctrl+Shift+key, or Cmd+Shift+key on a Mac. */
export const isShortcut = (e: KeyboardEvent, key: string) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === key;

const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
export const DICTATE_SHORTCUT = mac ? "⌘⇧D" : "Ctrl+Shift+D";
export const READ_SHORTCUT = mac ? "⌘⇧R" : "Ctrl+Shift+R";
