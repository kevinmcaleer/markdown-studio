// The <script> bundle's entry: everything here is on window.MarkdownEditor.

/// <reference path="./globals.d.ts" />
export { mount, DEFAULT_STATUS, DEFAULT_TOOLBAR } from "./mount";
export { slashCommands } from "./slashMenu";
export { renderMarkdown, createMarkdownIt } from "./markdown";
export { configureLanguageApi, fetchLanguageApi } from "./proofing/languageApi";
export { setDictionaryBase } from "./proofing/dictionaryUrls";

export const version = __MARKDOWN_EDITOR_VERSION__;
