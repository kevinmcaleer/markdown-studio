/// <reference path="./proofing/nspell.d.ts" />
/// <reference path="./markdown-it-plugins.d.ts" />
/// <reference path="./globals.d.ts" />

// @markdown-studio/markdown-editor: the Notes editor.
//
// Hosts that just want an editor on a page use `mount` (see README.md). The
// rest is what Markdown Studio's own apps build their note pages from: the
// React editor, its CodeMirror extensions, and the toolbars and status bar.

export {
  mount,
  DEFAULT_STATUS,
  DEFAULT_TOOLBAR,
  type MarkdownEditor,
  type MountOptions,
  type EditorEvents,
  type ToolbarItem,
  type ToolbarButton,
  type BuiltInTool,
  type StatusItem,
  type ImageInfo,
  type GuideSection,
  type Pane,
  type Stats,
} from "./mount";
export { DraftKeeper, readDraft, writeDraft, clearDraft, recoverableDraft, type DraftOptions, type DraftState, type StoredDraft } from "./draft";
export { linkPopover, openLinkPopover } from "./format/linkPopover";
export { calloutPicker, calloutTypeAt, calloutChoices } from "./calloutPicker";

// ---------------------------------------------------------------- the editor
export { Editor, markdownExtensions, type EditorProps } from "./Editor";
export { editorHighlighting, editorTheme } from "./editorTheme";
export { livePreview } from "./livePreview";
export {
  codeEditors,
  codeRenderers,
  type CodeEditor,
  type CodeEditorContext,
  type CodeEditorHandle,
  type CodeRenderer,
} from "./codeRenderers";
export { codeLanguageDescriptions, type CodeLanguage } from "./codeLanguages";
export {
  tableRenderers,
  tableNotes,
  tableSteppers,
  tableColumnActions,
  type TableRenderer,
  type TableRendererContext,
  type TableNote,
  type TableStepper,
  type TableStepperContext,
  type TableStepperSpec,
  type TableColumnAction,
  type TableColumnContext,
  type TableColumnOption,
} from "./tableWidget";
export { hiddenComments, hideComments, type HiddenComment } from "./hiddenComments";
export { pageBreaks, pageBreaksOn, pageBreakCommand, isPageBreak, PAGE_BREAK } from "./pageBreaks";
export { findTodos, completeTodo, todoMarks, type Todo } from "./todos";
export { slashMenu, slashCommands, filterCommands, applyCommand, withInsertTexts, type SlashCommand, type InsertTexts } from "./slashMenu";
export { smartPaste, insertImages, DEFAULT_MAX_IMAGE_BYTES, type SmartPasteOptions } from "./smartPaste";
export { findReplace } from "./findReplace";
export { setWriting, writingMode, writingStats, countWords, countChars, readingMinutes, type SelectionStats, type WritingSettings } from "./writingMode";
export { WritingBar, useDailyGoal, useTypewriter } from "./WritingBar";
export { diagnostics, setDiagnostics, applyFix, type Diagnostic } from "./diagnostics";

// ---------------------------------------------------------------- formatting
export { useFormatting } from "./format/FormatToolbar";
export { runFormat, formatKeymap, formatKeys, activeFormats, cycleHeading, clearFormatting, DEFAULT_SHORTCUTS, type FormatAction, type Block, type Mark, type ShortcutName } from "./format/formatting";
export { selectionToolbar } from "./format/selectionToolbar";

// ---------------------------------------------------------------- proofing and hints
export { proofing, setProofing, defaultProofing, checkSpelling, spellCount, type ProofingSettings } from "./proofing/proofing";
export { useProofing, type Proofing } from "./proofing/useProofing";
export { configureLanguageApi, fetchLanguageApi, type LanguageRequest } from "./proofing/languageApi";
export { setDictionaryBase } from "./proofing/dictionaryUrls";
export { useWritingLint } from "./lint/useWritingLint";

// ---------------------------------------------------------------- speech
export { speechEditor } from "./speech/speechEditor";
export { useDictation } from "./speech/useDictation";
export { useReadAloud } from "./speech/useReadAloud";

// ---------------------------------------------------------------- Markdown
export { renderMarkdown, renderInline, titleOf, createMarkdownIt, type MarkdownItInstance } from "./markdown";
export { calloutPlugin, calloutKinds, parseCalloutHeader, type CalloutKind, type CalloutHeader } from "./callouts";
export {
  galleryPlugin,
  galleryLayouts,
  galleryHtml,
  galleryImages,
  galleryOpenLine,
  parseGalleryOpen,
  findGalleries,
  wireGallery,
  type GalleryLayout,
  type GalleryImage,
  type GalleryBlock,
} from "./gallery";
export {
  cardsPlugin,
  cardsHtml,
  cardHtml,
  cardMarkdown,
  cardsMarkdown,
  cardsBlockMarkdown,
  cardsOpenLine,
  parseCardsOpen,
  parseCard,
  splitCards,
  findCardBlocks,
  type Card,
  type CardPicture,
  type CardsBlock,
} from "./cards";
export {
  videosPlugin,
  videosHtml,
  videoItems,
  videoFromLine,
  videoLine,
  videoUrl,
  videoThumbnail,
  videosOpenLine,
  findVideoBlocks,
  youTubeId,
  lookUpVideoTitle,
  fillVideoTitles,
  type Video,
  type VideosBlock,
} from "./videos";
export { videoRenderers, type VideoRenderer } from "./videosWidget";
export { imageCaption, imageCaptionPlugin, imageFigureClass } from "./imageCaption";
export { tableWidthsPlugin, delimiterDashes, columnWidths, colgroupHtml, widthsToDashes, WIDTH_STEP } from "./tableWidths";
export { imageSizePlugin, imageSizes, parseImageSize, imageSizeMarkdown, imageSizeClass, type ImageSize } from "./imageSize";
export {
  parseOutline,
  sectionAt,
  moveSection,
  upTarget,
  downTarget,
  shiftLevel,
  applyChanges,
  headingKeys,
  type Heading,
  type Change,
} from "./outline";
export { htmlToMarkdown } from "./htmlToMarkdown";
export { layersBlocks, layersCommand, openLayers, layersOpen, graphicFileName, newGraphicInsert, type LayersApi, type LayersEditor, type LayersHost, type LayersOptions, type LayersResult } from "./layersBlock";
export { isLayersUrl, layersUrl, layersOpener, LAYERS_MARK, type LayersOpener } from "./layersFacet";
export { parseDelimited } from "./delimited";
export { copyText } from "./clipboard";
