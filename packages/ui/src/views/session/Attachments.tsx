import { useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, ReactNode, RefObject } from 'react';
import type { InputBlock } from '@bizzi/protocol';
import { Icon } from '../../components/icons.tsx';
import { cx } from '../../components/ui.tsx';
import {
  buildInput,
  expandInDraft,
  hasContent,
  insertAt,
  liveAttachments,
  placeholderFor,
  removeFromDraft,
  shouldCondense,
  stripPlaceholders,
} from '../../lib/attachments.ts';
import type { Attachment } from '../../lib/attachments.ts';
import { dataUrl, prepareImage } from '../../lib/images.ts';

const MAX_IMAGES = 20;

export interface DraftAttachments {
  /** Attachments whose placeholder is still in the draft. */
  live: Attachment[];
  error: string | null;
  /** Images being read/resized. */
  pending: number;
  hasContent: (text: string) => boolean;
  build: (text: string) => InputBlock[];
  /** The typed part of the draft, without placeholders. */
  typed: (text: string) => string;
  clear: () => void;
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  addImages: (files: readonly File[]) => void;
  expand: (a: Attachment) => void;
  remove: (a: Attachment) => void;
}

/**
 * Paste, drop and pick for a composer textarea: images become `[Image N]`, long pasted text
 * becomes `[Pasted text N · L lines]`, both inserted at the caret. `onChange` receives the new
 * draft and caret, as if the user had typed it.
 */
export function useDraftAttachments(opts: {
  text: string;
  onChange: (text: string, caret: number) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** False when the target agent can't take images; pastes then say so. */
  images: boolean;
}): DraftAttachments {
  const [all, setAll] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const seq = useRef(0);
  const latest = useRef(opts);
  latest.current = opts;
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = opts.textarea.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [opts.text, opts.textarea]);

  const live = liveAttachments(opts.text, all);

  /** Put a placeholder over the current selection (or at the end when the textarea isn't focused). */
  const place = (a: Attachment): void => {
    const { text, textarea, onChange } = latest.current;
    const el = textarea.current;
    const focused = el !== null && document.activeElement === el;
    const start = focused ? el.selectionStart : text.length;
    const end = focused ? el.selectionEnd : text.length;
    const next = insertAt(text, start, end, placeholderFor(a));
    pendingCaret.current = next.caret;
    onChange(next.text, next.caret);
    // Keep the newest text value for a second placeholder in the same tick (several images).
    latest.current = { ...latest.current, text: next.text };
  };

  const addImages = (files: readonly File[]): void => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    if (!latest.current.images) {
      setError('This agent does not take images.');
      return;
    }
    const room = MAX_IMAGES - liveAttachments(latest.current.text, all).filter((a) => a.kind === 'image').length;
    if (imgs.length > room) setError(`At most ${MAX_IMAGES} images per message.`);
    else setError(null);
    const take = imgs.slice(0, Math.max(0, room));
    // Number them in paste order now; place each as soon as it's ready, in that order.
    const ids = take.map(() => ++seq.current);
    setPending((n) => n + take.length);
    void (async () => {
      const ready = take.map((f) => prepareImage(f).then((img) => ({ img, name: f.name }), (e: unknown) => ({ error: e })));
      for (let i = 0; i < ready.length; i++) {
        const r = await ready[i]!;
        setPending((n) => n - 1);
        if ('error' in r) {
          setError(r.error instanceof Error ? r.error.message : String(r.error));
          continue;
        }
        const a: Attachment = { kind: 'image', id: ids[i]!, ...r.img, ...(r.name ? { name: r.name } : {}) };
        setAll((xs) => [...xs, a]);
        place(a);
      }
    })();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const data = e.clipboardData;
    const files = Array.from(data.files).filter((f) => f.type.startsWith('image/'));
    const plain = data.getData('text/plain');
    // Office apps put a picture of the selection next to the text: text wins, unless the
    // "text" is only the copied files' names (Finder, Explorer).
    if (files.length > 0 && (!plain.trim() || files.every((f) => f.name && plain.includes(f.name)))) {
      e.preventDefault();
      addImages(files);
      return;
    }
    if (plain && shouldCondense(plain)) {
      e.preventDefault();
      const a: Attachment = { kind: 'text', id: ++seq.current, text: plain };
      setAll((xs) => [...xs, a]);
      place(a);
    }
  };

  const hasImageFiles = (e: DragEvent<HTMLElement>): boolean => Array.from(e.dataTransfer.items).some((i) => i.kind === 'file' && i.type.startsWith('image/'));

  const onDragOver = (e: DragEvent<HTMLElement>): void => {
    if (!hasImageFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: DragEvent<HTMLElement>): void => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    addImages(files);
  };

  const edit = (text: string): void => {
    pendingCaret.current = null;
    latest.current.onChange(text, text.length);
  };

  return {
    live,
    error,
    pending,
    hasContent: (text) => hasContent(text, all),
    build: (text) => buildInput(text, all),
    typed: (text) => stripPlaceholders(text, all),
    clear: () => {
      setAll([]);
      setError(null);
      seq.current = 0;
    },
    onPaste,
    onDragOver,
    onDrop,
    addImages,
    expand: (a) => edit(expandInDraft(latest.current.text, a)),
    remove: (a) => edit(removeFromDraft(latest.current.text, a)),
  };
}

/** The draft's attachments above the textarea: image thumbnails and condensed pastes. */
export function AttachmentTray(props: { draft: DraftAttachments }): ReactNode {
  const { live, pending } = props.draft;
  if (live.length === 0 && pending === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-1 pb-1.5" aria-label="Attachments">
      {live.map((a) =>
        a.kind === 'image' ? (
          <div key={`i${a.id}`} className="group relative h-14 w-14 overflow-hidden rounded-md border border-border bg-panel" title={a.name ? `Image ${a.id}: ${a.name}` : `Image ${a.id}`}>
            <img src={dataUrl(a.mediaType, a.dataBase64)} alt={`Image ${a.id}`} className="h-full w-full object-cover" />
            <span className="absolute bottom-0 left-0 rounded-tr bg-bg/80 px-1 text-[10px] leading-4 text-muted">{a.id}</span>
            <RemoveButton label={`Remove image ${a.id}`} onClick={() => props.draft.remove(a)} />
          </div>
        ) : (
          <div key={`t${a.id}`} className="flex h-7 max-w-full items-center gap-1 rounded-md border border-border bg-panel pr-0.5 pl-2 text-xs text-muted">
            <Icon name="file" size={12} />
            <span className="truncate" title={a.text.slice(0, 400)}>
              {placeholderFor(a).slice(1, -1)}
            </span>
            <button type="button" className="rounded px-1 hover:bg-panel-2 hover:text-fg" onClick={() => props.draft.expand(a)} title="Put the full text back in the message">
              expand
            </button>
            <button type="button" className="rounded p-0.5 hover:bg-panel-2 hover:text-fg" onClick={() => props.draft.remove(a)} aria-label={`Remove pasted text ${a.id}`}>
              <Icon name="x" size={12} />
            </button>
          </div>
        ),
      )}
      {pending > 0 ? (
        <div className="flex h-14 w-14 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-muted">reading…</div>
      ) : null}
    </div>
  );
}

function RemoveButton(props: { label: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.label}
      className={cx('absolute top-0.5 right-0.5 rounded-full bg-bg/85 p-0.5 text-muted hover:text-fg', 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100')}
    >
      <Icon name="x" size={12} />
    </button>
  );
}

/** Paperclip-style button that opens the image picker (phones have no paste for images). */
export function AttachImageButton(props: { draft: DraftAttachments; disabled?: boolean }): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => input.current?.click()}
        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50"
        title="Attach images (or paste / drop them)"
        aria-label="Attach images"
      >
        <Icon name="image" size={17} />
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          props.draft.addImages(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </>
  );
}
