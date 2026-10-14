export type ReaderKind = "pdf" | "snapshot" | "epub";

export type ReaderAnnotationType =
  | "highlight"
  | "note"
  | "image"
  | "ink"
  | "underline"
  | "text";

export type ReaderToolType = "pointer" | "highlight" | "image";

export interface ReaderToolInput {
  type: ReaderToolType;
  color?: string;
}

export interface ReaderToolState {
  type: ReaderToolType;
  color: string | null;
}

export interface ReaderAnnotation {
  key: string;
  type: ReaderAnnotationType;
  text: string | null;
  comment: string | null;
  color: string | null;
  pageLabel: string | null;
  sortIndex: string;
  position: string;
  tags: string[];
  isExternal: boolean;
  /** Rendered PNG supplied by Zotero's reader for image annotations. Never written to Zotero. */
  image?: string | null;
}

/**
 * The PDF highlight shown in the reader's live selection popup. It has no key yet: citing chooses a
 * locally-generated Zotero key only when this selection becomes a persisted highlight.
 */
export interface ReaderSelectionAnnotation {
  type: "highlight";
  text: string | null;
  color: string | null;
  pageLabel: string | null;
  sortIndex: string;
  position: string;
}

export interface OpenDocumentOptions {
  path: string;
  kind: ReaderKind;
  initialPosition?: string | null;
  annotations?: readonly ReaderAnnotation[];
}

export type NavigationTarget =
  | { page: number }
  | { annotationKey: string }
  | { position: string };

export type ReaderViewState = Record<string, unknown>;

export interface ReaderLiveness {
  activeViewInitialised: true;
  canvas: { height: number; width: number } | null;
  page: number | null;
  pageCount: number | null;
}

export interface ReaderZoomState {
  auto: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  canZoomReset: boolean;
  scale: number | null;
}

/**
 * A modified keystroke forwarded out of the reader to the host (ADR-0028). The field set is exactly
 * what a host chord resolver needs, so the host puts it through the same table a window keydown
 * takes and never learns that an iframe was involved.
 */
export interface ReaderHostChord {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Where keyboard delivery — the seam's third declared private-internals capability, beside
 * `getPageText()` and `getSelectionText()` — is currently listening. Both flags are true for a live
 * document; a vendored-build refresh that moves the reader's internals turns one false, which the
 * capability test asserts on so the trap cannot come back silently (ADR-0013/0028).
 */
export interface ReaderKeyboardDelivery {
  /** The `reader.html` window the host attached. */
  hostDocument: boolean;
  /** The active view's own nested document, reached through `_iframeWindow`. */
  viewDocument: boolean;
}

export interface ViewStatePersistence {
  cancel(): void;
  flush(): Promise<void>;
  schedule(state: ReaderViewState): void;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function createViewStatePersistence(
  persist: (state: ReaderViewState) => void | Promise<void>,
  delayMs = 250,
): ViewStatePersistence {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ReaderViewState | null = null;
  let lastSignature: string | null = null;
  let writes = Promise.resolve();

  const enqueue = (state: ReaderViewState): void => {
    const signature = JSON.stringify(stableValue(state));
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    const snapshot = structuredClone(state);
    writes = writes.then(() => persist(snapshot));
  };

  const writePending = (): void => {
    timer = undefined;
    if (!pending) {
      return;
    }
    const state = pending;
    pending = null;
    enqueue(state);
  };

  return {
    cancel() {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
      pending = null;
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
      }
      writePending();
      await writes;
    },
    schedule(state) {
      pending = structuredClone(state);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(writePending, delayMs);
    },
  };
}

export interface ReaderEmbedEventMap {
  "annotation-created": ReaderAnnotation;
  "annotation-updated": ReaderAnnotation;
  "annotation-deleted": ReaderAnnotation;
  "host-chord": ReaderHostChord;
  /** Escape stays a reader keystroke, but the host needs to clear its visible persistent-mode state. */
  "mark-mode-cancelled": undefined;
  "view-state-changed": ReaderViewState;
}

export type ReaderEmbedEventName = keyof ReaderEmbedEventMap;

export type ReaderEmbedListener<EventName extends ReaderEmbedEventName> = (
  payload: ReaderEmbedEventMap[EventName],
) => void | Promise<void>;

export interface ReaderHostCallbacks {
  onAddToNote?(annotations: unknown[]): void;
  onChangeSidebarView?(view: unknown): void;
  onChangeSidebarWidth?(width: number): void;
  onConfirm?(title: string, message: string, action: string): boolean;
  onCopyImage?(image: unknown): void | Promise<void>;
  onDeletePages?(pageIndexes: number[]): void | Promise<void>;
  onError?(error: Error): void;
  onOpenContextMenu?(parameters: unknown): void | Promise<void>;
  onOpenLink?(url: string): void;
  onOpenTagsPopup?(parameters: unknown): void;
  onRotatePages?(
    pageIndexes: number[],
    degrees: number,
  ): void | Promise<void>;
  onSaveImageAs?(image: unknown): void | Promise<void>;
  onSetDataTransferAnnotations?(
    dataTransfer: unknown,
    annotations: unknown[],
    fromText: boolean,
  ): void;
  onToggleSidebar?(open: boolean): void;
}

export interface ReaderEmbedOptions {
  readFile(path: string): Promise<Uint8Array>;
  authorName?: string;
  ftl?: readonly string[];
  hostCallbacks?: ReaderHostCallbacks;
}

interface RawReaderTag {
  name: string;
}

interface RawReaderAnnotation {
  id: string;
  type: ReaderAnnotationType;
  text?: string | null;
  comment?: string | null;
  color?: string | null;
  pageLabel?: string | null;
  sortIndex: string;
  position: unknown;
  tags?: Array<RawReaderTag | string>;
  isExternal?: boolean;
  image?: string | null;
}

interface ReaderPdfTextItem {
  str?: unknown;
  hasEOL?: unknown;
}

interface ReaderPdfApplication {
  pagesCount?: number;
  pdfDocument?: {
    getPage(pageNumber: number): Promise<{
      getTextContent(): Promise<{
        items: ReaderPdfTextItem[];
      }>;
    }>;
  };
  pdfViewer?: {
    currentScale?: number;
    currentPageNumber?: number;
  };
}

interface ReaderViewDocument {
  body?: {
    innerText?: string;
  };
  querySelector?(
    selector: string,
  ): { height?: unknown; width?: unknown } | null;
}

/** The keydown fields the seam reads. Kept structural: the reader's own window supplies real
 *  KeyboardEvents, and tests supply plain objects. */
interface ReaderKeyEvent {
  altKey?: unknown;
  code?: unknown;
  ctrlKey?: unknown;
  key?: unknown;
  metaKey?: unknown;
  shiftKey?: unknown;
}

type ReaderKeyListener = (event: ReaderKeyEvent) => void;

/** Anything the seam can listen on for keydown — a reader window, in practice. */
interface ReaderKeyTarget {
  addEventListener?(
    type: "keydown",
    listener: ReaderKeyListener,
    options?: { capture?: boolean },
  ): void;
  removeEventListener?(
    type: "keydown",
    listener: ReaderKeyListener,
    options?: { capture?: boolean },
  ): void;
}

interface ReaderViewWindow extends ReaderKeyTarget {
  PDFViewerApplication?: ReaderPdfApplication;
  document?: ReaderViewDocument;
  getSelection?(): { toString(): string } | null;
}

/** Keys that are modifiers themselves: holding ⌘ is not yet a chord. */
const MODIFIER_KEY_NAMES = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Meta",
  "Shift",
]);

/**
 * The forwarding rule (ADR-0028): only combinations involving ⌘, ⌃ or ⌥ leave the reader. Every
 * plain keystroke — arrows, page keys, typing into the reader's own find field — returns null and
 * stays entirely with the reader.
 */
function toHostChord(event: ReaderKeyEvent): ReaderHostChord | null {
  const altKey = event.altKey === true;
  const ctrlKey = event.ctrlKey === true;
  const metaKey = event.metaKey === true;
  if (!altKey && !ctrlKey && !metaKey) {
    return null;
  }
  const code = typeof event.code === "string" ? event.code : "";
  const key = typeof event.key === "string" ? event.key : "";
  if (!code || MODIFIER_KEY_NAMES.has(key)) {
    return null;
  }
  return {
    altKey,
    code,
    ctrlKey,
    key,
    metaKey,
    shiftKey: event.shiftKey === true,
  };
}

interface ZoteroReaderView {
  initializedPromise?: Promise<void>;
  _setState?(
    state: ReaderViewState,
    skipScroll: boolean,
  ): Promise<void>;
  _iframeDocument?: ReaderViewDocument;
  _iframeWindow?: ReaderViewWindow;
  iframeDocument?: ReaderViewDocument;
  iframeWindow?: ReaderViewWindow;
}

interface ZoteroReader {
  initializedPromise: Promise<void>;
  _lastViewPrimary?: boolean;
  _lastView?: ZoteroReaderView;
  _primaryView?: ZoteroReaderView;
  _state?: {
    primaryViewSelectionPopup?: {
      annotation?: Omit<RawReaderAnnotation, "id">;
    } | null;
    secondaryViewSelectionPopup?: {
      annotation?: Omit<RawReaderAnnotation, "id">;
    } | null;
    tool?: {
      color?: unknown;
      type?: unknown;
    };
  };
  navigate(
    location: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<void> | void;
  setAnnotations?(annotations: RawReaderAnnotation[]): void;
  setTool?(params: ReaderToolInput): void;
  zoomIn?(): void;
  zoomOut?(): void;
  zoomReset?(): void;
  readonly canZoomIn?: boolean;
  readonly canZoomOut?: boolean;
  readonly canZoomReset?: boolean;
  readonly zoomAutoEnabled?: boolean;
}

function readerViewDocument(
  view: ZoteroReaderView,
): ReaderViewDocument | undefined {
  return (
    view.iframeDocument ??
    view._iframeDocument ??
    view._iframeWindow?.document
  );
}

function readerViewWindow(
  view: ZoteroReaderView,
): ReaderViewWindow | undefined {
  return view.iframeWindow ?? view._iframeWindow;
}

interface CreateReaderOptions {
  type: Exclude<ReaderKind, "epub">;
  data: { buf: Uint8Array };
  annotations: RawReaderAnnotation[];
  authorName: string;
  ftl: string[];
  location?: Record<string, unknown>;
  primaryViewState?: ReaderViewState;
  readOnly: boolean;
  rtl: boolean;
  onAddToNote(annotations: unknown[]): void;
  onChangeSidebarView(view: unknown): void;
  onChangeSidebarWidth(width: number): void;
  onChangeViewState(
    state: ReaderViewState | null,
    primary: boolean,
  ): void;
  onConfirm(title: string, message: string, action: string): boolean;
  onCopyImage(image: unknown): void | Promise<void>;
  onDeleteAnnotations(keys: string[]): void;
  onDeletePages(pageIndexes: number[]): void | Promise<void>;
  onOpenContextMenu(parameters: unknown): void | Promise<void>;
  onOpenLink(url: string): void;
  onOpenTagsPopup(parameters: unknown): void;
  onRotatePages(
    pageIndexes: number[],
    degrees: number,
  ): void | Promise<void>;
  onSaveAnnotations(
    annotations: RawReaderAnnotation[],
    resolve: () => void,
  ): void;
  onSaveCustomThemes(themes: unknown[]): void;
  onSaveImageAs(image: unknown): void | Promise<void>;
  onTextSelectionAnnotationModeChange(mode: unknown): void;
  onSetDataTransferAnnotations(
    dataTransfer: unknown,
    annotations: unknown[],
    fromText: boolean,
  ): void;
  onToggleContextPane(open: boolean): void;
  onToggleSidebar(open: boolean): void;
}

export interface ReaderHostWindow extends ReaderKeyTarget {
  _reader?: ZoteroReader;
  createReader?(options: CreateReaderOptions): ZoteroReader;
}

function cloneViewState(
  state: ReaderViewState | null,
): ReaderViewState | null {
  return state ? structuredClone(state) : null;
}

function parsePosition(position: string): unknown {
  try {
    return JSON.parse(position) as unknown;
  } catch {
    throw new Error("Reader position must be valid JSON");
  }
}

function toRawAnnotation(
  annotation: ReaderAnnotation,
): RawReaderAnnotation {
  return {
    color: annotation.color,
    comment: annotation.comment,
    id: annotation.key,
    isExternal: annotation.isExternal,
    pageLabel: annotation.pageLabel,
    position: parsePosition(annotation.position),
    sortIndex: annotation.sortIndex,
    tags: annotation.tags.map((name) => ({ name })),
    text: annotation.text,
    type: annotation.type,
    ...(annotation.image ? { image: annotation.image } : {}),
  };
}

function toSeamAnnotation(
  annotation: RawReaderAnnotation,
): ReaderAnnotation {
  if (!annotation.position) {
    throw new Error(
      `Reader annotation ${annotation.id} has no position`,
    );
  }
  return {
    color: annotation.color ?? null,
    comment: annotation.comment ?? null,
    isExternal: annotation.isExternal ?? false,
    key: annotation.id,
    pageLabel: annotation.pageLabel ?? null,
    position: JSON.stringify(annotation.position),
    sortIndex: annotation.sortIndex,
    tags: (annotation.tags ?? []).map((tag) =>
      typeof tag === "string" ? tag : tag.name,
    ),
    text: annotation.text ?? null,
    type: annotation.type,
    ...(annotation.image ? { image: annotation.image } : {}),
  };
}

function annotationSignatureWithoutImage(
  annotation: ReaderAnnotation,
): string {
  const { image: _image, ...persisted } = annotation;
  return JSON.stringify(stableValue(persisted));
}

function initialLocation(
  initialPosition: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!initialPosition) {
    return undefined;
  }
  const position = parsePosition(initialPosition);
  if (
    position &&
    typeof position === "object" &&
    !Array.isArray(position) &&
    "pageIndex" in position &&
    !("rects" in position) &&
    !("paths" in position)
  ) {
    return position as Record<string, unknown>;
  }
  return { position };
}

export class ReaderEmbed {
  readonly #options: ReaderEmbedOptions;
  readonly #listeners = new Map<
    ReaderEmbedEventName,
    Set<ReaderEmbedListener<ReaderEmbedEventName>>
  >();
  readonly #knownAnnotations = new Map<string, ReaderAnnotation>();
  #window: ReaderHostWindow | null = null;
  #reader: ZoteroReader | null = null;
  #kind: Exclude<ReaderKind, "epub"> | null = null;
  #viewState: ReaderViewState | null = null;
  #activeViewInitialised = false;
  #pendingEvents: Promise<void> = Promise.resolve();
  #keyboardDetachers: Array<() => void> = [];
  #keyboardDelivery: ReaderKeyboardDelivery = {
    hostDocument: false,
    viewDocument: false,
  };

  constructor(options: ReaderEmbedOptions) {
    this.#options = options;
  }

  attachWindow(window: ReaderHostWindow): void {
    // A document switch discards the iframe and hands over a new one (ADR-0014/0015), so keyboard
    // delivery is torn down and re-attached here rather than assumed to survive.
    this.detachKeyboardDelivery();
    this.#window = window;
    this.#reader = null;
    this.#kind = null;
    this.#activeViewInitialised = false;
    this.#attachKeyboardTarget(window, "hostDocument");
  }

  on<EventName extends ReaderEmbedEventName>(
    eventName: EventName,
    listener: ReaderEmbedListener<EventName>,
  ): () => void {
    const listeners =
      this.#listeners.get(eventName) ??
      new Set<ReaderEmbedListener<ReaderEmbedEventName>>();
    listeners.add(
      listener as ReaderEmbedListener<ReaderEmbedEventName>,
    );
    this.#listeners.set(eventName, listeners);
    return () => {
      listeners.delete(
        listener as ReaderEmbedListener<ReaderEmbedEventName>,
      );
    };
  }

  async openDocument(options: OpenDocumentOptions): Promise<void> {
    if (options.kind === "epub") {
      throw new Error(
        "EPUB is admitted by the reader seam but is not wired in ReadFlex 0.11",
      );
    }
    if (!this.#window?.createReader) {
      throw new Error(
        "Attach a loaded reader.html window before opening a document",
      );
    }
    if (this.#window._reader) {
      throw new Error(
        "Attach a fresh reader.html window before opening another document",
      );
    }

    const annotations = [...(options.annotations ?? [])];
    this.#knownAnnotations.clear();
    for (const annotation of annotations) {
      this.#knownAnnotations.set(annotation.key, annotation);
    }
    const data = {
      buf: await this.#options.readFile(options.path),
    };
    const callbacks = this.#options.hostCallbacks;
    const location = initialLocation(options.initialPosition);
    const reader = this.#window.createReader({
      annotations: annotations.map(toRawAnnotation),
      authorName: this.#options.authorName ?? "",
      data,
      ftl: [...(this.#options.ftl ?? [])],
      ...(location ? { location } : {}),
      ...(this.#viewState
        ? { primaryViewState: cloneViewState(this.#viewState)! }
        : {}),
      onAddToNote: (items) => callbacks?.onAddToNote?.(items),
      onChangeSidebarView: (view) =>
        callbacks?.onChangeSidebarView?.(view),
      onChangeSidebarWidth: (width) =>
        callbacks?.onChangeSidebarWidth?.(width),
      onChangeViewState: (state, primary) => {
        if (!primary || !state) {
          return;
        }
        this.#viewState = cloneViewState(state);
        this.#queueEvent("view-state-changed", state);
      },
      onConfirm: (title, message, action) =>
        callbacks?.onConfirm?.(title, message, action) ?? false,
      onCopyImage: (image) => callbacks?.onCopyImage?.(image),
      onDeleteAnnotations: (keys) => {
        for (const key of keys) {
          const annotation = this.#knownAnnotations.get(key);
          if (!annotation) {
            this.#reportError(
              new Error(
                `Reader deleted unknown annotation key ${key}`,
              ),
            );
            continue;
          }
          this.#knownAnnotations.delete(key);
          this.#queueEvent("annotation-deleted", annotation);
        }
      },
      onDeletePages: (pageIndexes) =>
        callbacks?.onDeletePages?.(pageIndexes),
      onOpenContextMenu: (parameters) =>
        callbacks?.onOpenContextMenu?.(parameters),
      onOpenLink: (url) => callbacks?.onOpenLink?.(url),
      onOpenTagsPopup: (parameters) =>
        callbacks?.onOpenTagsPopup?.(parameters),
      onRotatePages: (pageIndexes, degrees) =>
        callbacks?.onRotatePages?.(pageIndexes, degrees),
      onSaveAnnotations: (rawAnnotations, resolve) => {
        void this.#saveAnnotations(rawAnnotations).then(
          resolve,
          (error: unknown) => {
            this.#reportError(
              error instanceof Error
                ? error
                : new Error(String(error)),
            );
            resolve();
          },
        );
      },
      onSaveCustomThemes: () => {},
      onSaveImageAs: (image) => callbacks?.onSaveImageAs?.(image),
      onSetDataTransferAnnotations: (
        dataTransfer,
        items,
        fromText,
      ) =>
        callbacks?.onSetDataTransferAnnotations?.(
          dataTransfer,
          items,
          fromText,
        ),
      onTextSelectionAnnotationModeChange: () => {},
      onToggleContextPane: () => {},
      onToggleSidebar: (open) =>
        callbacks?.onToggleSidebar?.(open),
      readOnly: false,
      rtl: false,
      type: options.kind,
    });
    this.#reader = reader;
    this.#kind = options.kind;
    const view = reader._lastView;
    if (!view) {
      throw new Error(
        "The reader did not publish an active document view",
      );
    }
    if (!view.initializedPromise) {
      throw new Error(
        "The active document view did not publish an initialisation promise",
      );
    }
    await view.initializedPromise;
    this.#activeViewInitialised = true;
    // The reader renders inside a FURTHER nested iframe of its own, so the host window's listener
    // above never sees a keystroke aimed at the page. `_iframeWindow` is the only route to it — the
    // same private internal `getPageText()` uses, sanctioned inside the seam by ADR-0028.
    this.#attachKeyboardTarget(readerViewWindow(view), "viewDocument");
  }

  async navigateTo(target: NavigationTarget): Promise<void> {
    const reader = this.#requireReader();
    if ("page" in target) {
      if (!Number.isInteger(target.page) || target.page < 1) {
        throw new Error("Reader page targets are one-based integers");
      }
      await reader.navigate({ pageIndex: target.page - 1 });
      return;
    }
    if ("annotationKey" in target) {
      await reader.navigate({ annotationID: target.annotationKey });
      return;
    }
    await reader.navigate({
      position: parsePosition(target.position),
    });
  }

  /** Move an open reader to a view previously returned by saveViewState(). */
  async navigateToViewState(state: ReaderViewState): Promise<void> {
    const reader = this.#requireReader();
    const snapshot = cloneViewState(state)!;
    if (this.#kind === "pdf") {
      const primaryView = reader._primaryView;
      if (
        !primaryView?.initializedPromise ||
        typeof primaryView._setState !== "function"
      ) {
        throw new Error(
          "The PDF reader cannot restore a live view state",
        );
      }
      await primaryView.initializedPromise;
      await primaryView._setState(snapshot, false);
    } else {
      await reader.navigate(snapshot);
    }
    this.#viewState = cloneViewState(snapshot);
  }

  /**
   * Paint annotations the host created through another input path, while preserving every mark
   * already loaded. Zotero's reader publishes `setAnnotations()` publicly; the seam owns the merge
   * because it already owns the canonical key map used to classify later reader edits.
   */
  upsertAnnotations(annotations: readonly ReaderAnnotation[]): void {
    const reader = this.#requireReader();
    if (typeof reader.setAnnotations !== "function") {
      throw new Error(
        "The reader does not publish setAnnotations(), so host-created highlights cannot be painted",
      );
    }
    for (const annotation of annotations) {
      this.#knownAnnotations.set(annotation.key, annotation);
    }
    reader.setAnnotations(
      [...this.#knownAnnotations.values()].map(toRawAnnotation),
    );
  }

  /** Activate a public Zotero reader tool and report the state the reader actually accepted. */
  setTool(tool: ReaderToolInput): ReaderToolState {
    const reader = this.#requireReader();
    if (typeof reader.setTool !== "function") {
      throw new Error("The reader does not publish setTool(), so mark tools are unavailable");
    }
    reader.setTool(tool);
    return this.getToolState();
  }

  /** The live public tool state, used so host chrome never claims a mode the reader did not enter. */
  getToolState(): ReaderToolState {
    const tool = this.#requireReader()._state?.tool;
    if (
      !tool
      || (tool.type !== "pointer" && tool.type !== "highlight" && tool.type !== "image")
    ) {
      throw new Error("The reader did not publish a supported mark-tool state");
    }
    return {
      color: typeof tool.color === "string" ? tool.color : null,
      type: tool.type,
    };
  }

  /** A snapshot for a drag payload; callers cannot mutate the seam's canonical annotation map. */
  annotationForKey(key: string): ReaderAnnotation | null {
    const annotation = this.#knownAnnotations.get(key);
    return annotation ? structuredClone(annotation) : null;
  }

  saveViewState(): ReaderViewState | null {
    return cloneViewState(this.#viewState);
  }

  restoreViewState(state: ReaderViewState | null): void {
    if (this.#reader) {
      throw new Error(
        "Restore reader view state before openDocument()",
      );
    }
    this.#viewState = cloneViewState(state);
  }

  async getPageText(): Promise<string> {
    const view = this.#requireView();
    if (this.#kind === "pdf") {
      const application =
        readerViewWindow(view)?.PDFViewerApplication;
      const pageNumber =
        application?.pdfViewer?.currentPageNumber;
      const pdfDocument = application?.pdfDocument;
      if (!pageNumber || !pdfDocument) {
        throw new Error("The current PDF page is not ready");
      }
      const textContent = await (
        await pdfDocument.getPage(pageNumber)
      ).getTextContent();
      let text = "";
      for (const item of textContent.items) {
        if (typeof item.str !== "string") {
          continue;
        }
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      return text.trim();
    }

    return readerViewDocument(view)?.body?.innerText?.trim() ?? "";
  }

  getSelectionText(): string {
    return (
      readerViewWindow(this.#requireView())
        ?.getSelection?.()
        ?.toString()
        .trim() ?? ""
    );
  }

  /**
   * The live selection annotation, named so it can be asserted on (ADR-0035). The selection popup is
   * the only published live object that carries both the position and the `sortIndex` Zotero needs.
   */
  getSelectionAnnotation(): ReaderSelectionAnnotation | null {
    const reader = this.#requireReader();
    const state = reader._state;
    const popupPath = reader._lastViewPrimary
      ? "primaryViewSelectionPopup"
      : "secondaryViewSelectionPopup";
    if (!state || !(popupPath in state)) {
      throw new Error(
        "The reader's selection popup internals are unavailable",
      );
    }
    const popup = state[popupPath];
    const annotation = popup?.annotation;
    const position = annotation?.position as {
      pageIndex?: unknown;
      rects?: unknown;
    } | undefined;
    const rects = position?.rects;
    if (
      !annotation
      || annotation.type !== "highlight"
      || typeof annotation.sortIndex !== "string"
      || !annotation.sortIndex
      || typeof position?.pageIndex !== "number"
      || !Number.isFinite(position.pageIndex)
      || !Array.isArray(rects)
      || rects.length === 0
      || !rects.every((rect: unknown) =>
        Array.isArray(rect)
        && rect.length === 4
        && rect.every((value) => typeof value === "number" && Number.isFinite(value)))
    ) {
      return null;
    }
    return {
      color: annotation.color ?? null,
      pageLabel: annotation.pageLabel ?? null,
      position: JSON.stringify(position),
      sortIndex: annotation.sortIndex,
      text: annotation.text ?? null,
      type: "highlight",
    };
  }

  getLiveness(): ReaderLiveness {
    const view = this.#requireView();
    if (!this.#activeViewInitialised) {
      throw new Error("The active reader view has not initialised");
    }
    const application = readerViewWindow(view)?.PDFViewerApplication;
    const rawPage = application?.pdfViewer?.currentPageNumber;
    const rawPageCount = application?.pagesCount;
    const rawCanvas = readerViewDocument(view)?.querySelector?.(
      "#viewer .page canvas",
    );
    const width =
      typeof rawCanvas?.width === "number" ? rawCanvas.width : 0;
    const height =
      typeof rawCanvas?.height === "number" ? rawCanvas.height : 0;
    return {
      activeViewInitialised: true,
      canvas:
        width > 0 && height > 0 ? { height, width } : null,
      page:
        typeof rawPage === "number" && rawPage > 0 ? rawPage : null,
      pageCount:
        typeof rawPageCount === "number" && rawPageCount > 0
          ? rawPageCount
          : null,
    };
  }

  getZoomState(): ReaderZoomState {
    const reader = this.#requireReader();
    const scale = readerViewWindow(this.#requireView())
      ?.PDFViewerApplication?.pdfViewer?.currentScale;
    return {
      auto: reader.zoomAutoEnabled === true,
      canZoomIn: reader.canZoomIn !== false,
      canZoomOut: reader.canZoomOut !== false,
      canZoomReset: reader.canZoomReset !== false,
      scale: typeof scale === "number" && Number.isFinite(scale) ? scale : null,
    };
  }

  zoomIn(): ReaderZoomState {
    const reader = this.#requireReader();
    if (typeof reader.zoomIn !== "function") throw new Error("The PDF reader has no zoom-in command");
    reader.zoomIn();
    return this.getZoomState();
  }

  zoomOut(): ReaderZoomState {
    const reader = this.#requireReader();
    if (typeof reader.zoomOut !== "function") throw new Error("The PDF reader has no zoom-out command");
    reader.zoomOut();
    return this.getZoomState();
  }

  zoomReset(): ReaderZoomState {
    const reader = this.#requireReader();
    if (typeof reader.zoomReset !== "function") throw new Error("The PDF reader has no zoom-reset command");
    reader.zoomReset();
    return this.getZoomState();
  }

  /**
   * Keyboard delivery, named so it can be asserted on (ADR-0028). Both flags are true once a
   * document is live; either turning false means the reader's internals moved and host chords are
   * dying inside the reader again.
   */
  getKeyboardDelivery(): ReaderKeyboardDelivery {
    return { ...this.#keyboardDelivery };
  }

  /** Stop listening inside the reader. Called for you when a new window is attached. */
  detachKeyboardDelivery(): void {
    const detachers = this.#keyboardDetachers;
    this.#keyboardDetachers = [];
    for (const detach of detachers) {
      detach();
    }
    this.#keyboardDelivery = { hostDocument: false, viewDocument: false };
  }

  /** Capture phase, and deliberately without `preventDefault()`: the reader keeps its own shortcuts,
   *  and the host acts only on chords its command table actually claims. */
  #attachKeyboardTarget(
    target: ReaderKeyTarget | undefined,
    slot: keyof ReaderKeyboardDelivery,
  ): void {
    if (typeof target?.addEventListener !== "function") {
      this.#reportError(
        new Error(
          `The reader ${
            slot === "hostDocument" ? "window" : "active view"
          } accepts no keydown listener, so host chords cannot be delivered (ADR-0028)`,
        ),
      );
      return;
    }
    const listener: ReaderKeyListener = (event) => {
      if (
        event.key === "Escape"
        && event.altKey !== true
        && event.ctrlKey !== true
        && event.metaKey !== true
      ) {
        this.#queueEvent("mark-mode-cancelled", undefined);
      }
      const chord = toHostChord(event);
      if (chord) {
        this.#queueEvent("host-chord", chord);
      }
    };
    target.addEventListener("keydown", listener, { capture: true });
    this.#keyboardDelivery = { ...this.#keyboardDelivery, [slot]: true };
    this.#keyboardDetachers.push(() => {
      target.removeEventListener?.("keydown", listener, { capture: true });
    });
  }

  #queueEvent<EventName extends ReaderEmbedEventName>(
    eventName: EventName,
    payload: ReaderEmbedEventMap[EventName],
  ): void {
    this.#pendingEvents = this.#pendingEvents
      .then(() => this.#emit(eventName, payload))
      .catch((error: unknown) => {
        this.#reportError(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      });
  }

  async #emit<EventName extends ReaderEmbedEventName>(
    eventName: EventName,
    payload: ReaderEmbedEventMap[EventName],
  ): Promise<void> {
    const listeners = this.#listeners.get(eventName);
    if (!listeners) {
      return;
    }
    await Promise.all(
      [...listeners].map((listener) => listener(payload)),
    );
  }

  async #saveAnnotations(
    rawAnnotations: RawReaderAnnotation[],
  ): Promise<void> {
    await this.#pendingEvents;
    for (const rawAnnotation of rawAnnotations) {
      const annotation = toSeamAnnotation(rawAnnotation);
      const previous = this.#knownAnnotations.get(annotation.key);
      const eventName = previous
        ? "annotation-updated"
        : "annotation-created";
      this.#knownAnnotations.set(annotation.key, annotation);
      // Zotero renders an area's PNG after creating its database annotation, then saves the same
      // annotation again with only `image` added. The PNG is a drag payload, not a Zotero field; emitting
      // this as an update would create a phantom second outbox row (ADR-0037).
      if (
        previous
        && annotation.image
        && annotationSignatureWithoutImage(previous)
          === annotationSignatureWithoutImage(annotation)
      ) {
        continue;
      }
      await this.#emit(eventName, annotation);
    }
  }

  #reportError(error: Error): void {
    this.#options.hostCallbacks?.onError?.(error);
  }

  #requireReader(): ZoteroReader {
    if (!this.#reader) {
      throw new Error("No reader document is open");
    }
    return this.#reader;
  }

  #requireView(): ZoteroReaderView {
    const view = this.#requireReader()._lastView;
    if (!view) {
      throw new Error("The active reader view is not ready");
    }
    return view;
  }
}
