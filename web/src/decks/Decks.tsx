import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../api";
import { Link } from "../Link";
import { files, type FileMeta, type Tree } from "../notes/filesApi";
import { folderPaths } from "../notes/tree";
import { navigate } from "../router";
import { DECK_SUFFIX, deckTitle, isDeck, parseDeck, STARTER_DECK } from "./deck";
import { DeckView } from "./DeckView";
import { PresenterView } from "./Present";
import { SlideView } from "./SlideView";

// The Decks app. Decks are Markdown files named *.deck.md in the same files and
// folders as Notes, so sharing, comments and co-editing work the same way.
// /decks lists them, /decks/:id opens one, /decks/:id/presenter is presenter view.

export function Decks({ path }: { path: string }) {
  const match = /^\/decks\/(\d+)(\/presenter)?\/?$/.exec(path);
  const fileId = match ? Number(match[1]) : null;
  if (fileId !== null && match?.[2]) return <PresenterView fileId={fileId} />;
  if (fileId !== null)
    return (
      <div className="notes-main decks-page">
        <DeckView key={fileId} fileId={fileId} />
      </div>
    );
  return <DeckList />;
}

function DeckList() {
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    try {
      setTree(await files.tree());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your decks.");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const decks = useMemo(() => (tree?.files.filter(isDeck) ?? []).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [tree]);
  const paths = useMemo(() => new Map(folderPaths(tree?.folders ?? []).map((f) => [f.id, f.path])), [tree]);

  async function newDeck() {
    setError("");
    try {
      const taken = new Set(tree?.files.filter((f) => f.folder_id === null).map((f) => f.name.toLowerCase()));
      let name = "Untitled deck";
      for (let n = 2; taken.has((name + DECK_SUFFIX).toLowerCase()); n++) name = `Untitled deck ${n}`;
      const { file } = await files.createNote(name + DECK_SUFFIX, null, STARTER_DECK);
      navigate(`/decks/${file.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't make a new deck.");
    }
  }

  async function remove(file: FileMeta) {
    if (!window.confirm(`Delete “${deckTitle(file)}”? This can't be undone.`)) return;
    try {
      await files.remove(file.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete it.");
    }
    reload();
  }

  return (
    <section className="deck-list">
      <div className="deck-list-head">
        <h1>Decks</h1>
        <div className="spacer" />
        <button type="button" className="primary" onClick={newDeck}>
          New deck
        </button>
      </div>
      <p className="muted">
        Slides written in Markdown, presented from here or downloaded for PowerPoint and Keynote. Decks are files ending in <code>{DECK_SUFFIX}</code>, so they also
        show up in <Link href="/notes">Notes</Link>.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!tree ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : decks.length === 0 ? (
        <div className="notes-empty">
          <p className="muted">You don't have any decks yet.</p>
          <button type="button" className="primary" onClick={newDeck}>
            Make your first deck
          </button>
        </div>
      ) : (
        <ul className="deck-grid">
          {decks.map((file) => (
            <li key={file.id} className="deck-card">
              <Link href={`/decks/${file.id}`} className="deck-card-link">
                <FirstSlide file={file} />
                <span className="deck-card-name">{deckTitle(file)}</span>
                <span className="muted small">
                  {file.folder_id !== null && paths.get(file.folder_id) ? `${paths.get(file.folder_id)} · ` : ""}
                  {new Date(file.updated_at).toLocaleDateString()}
                </span>
              </Link>
              <button type="button" className="icon-button deck-card-delete" aria-label={`Delete ${deckTitle(file)}`} title="Delete" onClick={() => remove(file)}>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The deck's first slide, as its card's picture. */
function FirstSlide({ file }: { file: FileMeta }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    files.text(file.id).then(
      (t) => live && setText(t),
      () => live && setText(""),
    );
    return () => {
      live = false;
    };
  }, [file.id, file.updated_at]);
  const first = useMemo(() => (text ? parseDeck(text).slides[0] : undefined), [text]);
  return first ? <SlideView slide={first} /> : <div className="slide" aria-hidden="true" />;
}
