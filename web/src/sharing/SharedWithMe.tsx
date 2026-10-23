import { useEffect, useState } from "react";
import { Link } from "../Link";
import { ROLE_LABELS, sharing, type SharedFile } from "./api";

/** Files other people shared with you, by name or through a link you opened. */
export function SharedWithMe({ hrefFor = (f: SharedFile) => `/notes/${f.id}` }: { hrefFor?: (f: SharedFile) => string }) {
  const [files, setFiles] = useState<SharedFile[] | null>(null);

  useEffect(() => {
    sharing.sharedWithMe().then(
      (data) => setFiles(data.files),
      () => setFiles([]),
    );
  }, []);

  if (!files || files.length === 0) return null;

  return (
    <section className="shared-with-me">
      <h2>Shared with me</h2>
      <ul>
        {files.map((f) => (
          <li key={f.id}>
            <Link href={hrefFor(f)}>{f.name}</Link>
            <span className="muted small">
              {f.owner} · {ROLE_LABELS[f.role]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
