import { useEffect, useRef, useState } from "react";
import type { ImageInfo } from "./options";
import { Popover, type Anchor } from "./Popover";

// The image picker, behind the toolbar's image button and "/image": the
// host's library to pick from, an upload button, and a URL field.

export function ImagePicker({
  anchor,
  onClose,
  library,
  canUpload,
  accept,
  onPick,
  onUpload,
}: {
  anchor: Anchor;
  onClose: () => void;
  library?: () => Promise<ImageInfo[]>;
  canUpload: boolean;
  accept: string;
  onPick: (image: ImageInfo) => void;
  onUpload: (files: File[]) => void;
}) {
  const [images, setImages] = useState<ImageInfo[] | null>(library ? null : []);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!library) return;
    let live = true;
    library().then(
      (list) => live && setImages(list),
      (err: unknown) => {
        if (!live) return;
        setImages([]);
        setError(err instanceof Error ? err.message : "Couldn't load the images.");
      },
    );
    return () => {
      live = false;
    };
  }, [library]);

  const name = (image: ImageInfo) => image.alt || image.url.split(/[/?#]/).filter(Boolean).pop() || "Image";

  return (
    <Popover anchor={anchor} onClose={onClose} className="mde-images" label="Insert an image">
      {canUpload && (
        <div className="row">
          <button type="button" className="primary" onClick={() => file.current?.click()}>
            Upload an image…
          </button>
          <span className="muted small">or drop one on the text</span>
          <input
            ref={file}
            type="file"
            accept={accept}
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) onUpload(files);
            }}
          />
        </div>
      )}
      {library && (
        <>
          <h3>Your images</h3>
          {error && <p className="error">{error}</p>}
          {images === null ? (
            <p className="muted small" aria-busy="true">
              Loading…
            </p>
          ) : images.length ? (
            <div className="mde-image-grid">
              {images.map((image) => (
                <button key={image.url} type="button" title={name(image)} onClick={() => onPick(image)}>
                  <img src={image.thumb || image.url} alt="" loading="lazy" />
                  <span>{name(image)}</span>
                </button>
              ))}
            </div>
          ) : (
            !error && <p className="muted small">No images yet.</p>
          )}
        </>
      )}
      <form
        className="mde-image-url"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) onPick({ url: url.trim() });
        }}
      >
        <input
          type="text"
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Or an image's URL: https://… or /path"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Image URL"
        />
        <button type="submit" className="menu-button">
          Insert
        </button>
      </form>
    </Popover>
  );
}
