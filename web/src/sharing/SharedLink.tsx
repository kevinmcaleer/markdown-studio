import { useEffect, useState } from "react";
import { ApiError, setShareToken } from "../api";
import { Link } from "../Link";
import { NoteView } from "../notes/NoteView";
import { navigate } from "../router";
import { useSession } from "../session";
import { ROLE_LABELS, sharing, type OpenedLink } from "./api";

/**
 * /s/<token>: a note opened through a share link. Works signed out when the
 * link allows it; otherwise sends the visitor to sign in and back here.
 */
// Bumped each time a link page opens, so a closing page doesn't clear the token
// a newer one just set.
let opening = 0;

export function SharedLink({ token }: { token: string }) {
  const { user } = useSession();
  const [opened, setOpened] = useState<OpenedLink | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const mine = ++opening;
    setShareToken(token);
    sharing.open(token).then(
      (data) => {
        if (!live) return;
        // The owner gets their normal editor, with the file browser.
        if (data.role === "owner") navigate(`/notes/${data.file.id}`, { replace: true });
        else setOpened(data);
      },
      (err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate(`/login?next=${encodeURIComponent(`/s/${token}`)}`, { replace: true });
        } else {
          setError(err instanceof ApiError ? err.message : "Couldn't open this link.");
        }
      },
    );
    return () => {
      live = false;
      // After the note's own cleanup (which may save once more with the token).
      setTimeout(() => {
        if (opening === mine) setShareToken(null);
      });
    };
  }, [token]);

  if (error)
    return (
      <section className="narrow">
        <h1>Can't open this link</h1>
        <p className="muted">{error}</p>
        <Link href="/">Go to Markdown Studio</Link>
      </section>
    );
  if (!opened) return <div className="splash" aria-busy="true" />;

  return (
    <div className="shared-note">
      <div className="shared-banner">
        <span>
          Shared by <strong>{opened.file.owner}</strong> · {ROLE_LABELS[opened.role]}
        </span>
        <span className="spacer" />
        {!user && (
          <Link href={`/login?next=${encodeURIComponent(`/s/${token}`)}`} className="small">
            Sign in
          </Link>
        )}
      </div>
      <NoteView fileId={opened.file.id} onRenamed={() => {}} onSaved={() => {}} />
    </div>
  );
}
