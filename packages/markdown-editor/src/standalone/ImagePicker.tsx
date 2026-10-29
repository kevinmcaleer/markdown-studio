import { useEffect, useRef, useState } from "react";
import { imageSizes, type ImageSize } from "../imageSize";
import type { ImageInfo } from "./options";
import { Popover, type Anchor } from "./Popover";

// The image picker, behind the toolbar's image button and "/image": the
// host's library to pick from, an upload button, and a URL field, with the
// size the picked image shows at (its `{size}`, see imageSize.ts).

/** Whether ``image`` already appears in ``doc``: the host's ``used`` when it
 *  says, otherwise whether the text contains the image's URL. */
export function isImageUsed(image: ImageInfo, doc: string): boolean {
  return image.used ?? doc.includes(image.url);
}

export function ImagePicker({
  anchor,
  onClose,
  library,
  canUpload,
  accept,
  onPick,
  onUpload,
  doc = "",
}: {
  anchor: Anchor;
  onClose: () => void;
  library?: () => Promise<ImageInfo[]>;
  canUpload: boolean;
  accept: string;
  onPick: (image: ImageInfo, size: ImageSize) => void;
  onUpload: (files: File[]) => void;
  /** The text, so images already in it can be marked. */
  doc?: string;
}) {
  const [images, setImages] = useState<ImageInfo[] | null>(library ? null : []);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [size, setSize] = useState<ImageSize>("full");
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
      <div className="mde-image-size" role="group" aria-label="Size">
        <span className="muted small">Size</span>
        {imageSizes.map((s) => (
          <button key={s.size} type="button" title={s.title} aria-pressed={size === s.size} onClick={() => setSize(s.size)}>
            {s.label}
          </button>
        ))}
      </div>
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
              {images.map((image) => {
                const used = isImageUsed(image, doc);
                return (
                  <button
                    key={image.url}
                    type="button"
                    className={used ? "used" : undefined}
                    title={used ? `${name(image)} (already in the text)` : name(image)}
                    onClick={() => onPick(image, size)}
                  >
                    <img src={image.thumb || image.url} alt="" loading="lazy" />
                    {used && <em className="mde-image-used">In text</em>}
                    <span>{name(image)}</span>
                  </button>
                );
              })}
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
          if (url.trim()) onPick({ url: url.trim() }, size);
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
