import { useState } from "react";
import { ShareDialog } from "./ShareDialog";

/** The note toolbar's Share button; only the owner sees it. */
export function ShareButton({ fileId, fileName }: { fileId: number; fileName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="menu-button share-button" onClick={() => setOpen(true)}>
        Share
      </button>
      {open && <ShareDialog fileId={fileId} fileName={fileName} onClose={() => setOpen(false)} />}
    </>
  );
}
