"""The server's Markdown parser, matching the editor's preview.

Same dialect as ``web/src/notes/markdown.ts``: CommonMark plus GFM tables,
strikethrough, autolinks and task lists, footnotes, typographic quotes, and
``==highlight==``. Raw HTML in a note is shown as text, never passed through.
"""

from __future__ import annotations

from functools import lru_cache

from markdown_it import MarkdownIt
from markdown_it.rules_inline.state_inline import Delimiter, StateInline
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from pygments import highlight as pygments_highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_lexer_by_name
from pygments.util import ClassNotFound

EQUALS = 0x3D


def _mark_tokenize(state: StateInline, silent: bool) -> bool:
    """``==`` runs become delimiters, paired up in ``_mark_post_process``."""
    start = state.pos
    if silent or state.src[start] != "=":
        return False
    scanned = state.scanDelims(start, True)
    length = scanned.length
    if length < 2:
        return False
    if length % 2:
        token = state.push("text", "", 0)
        token.content = "="
        length -= 1
    for _ in range(0, length, 2):
        token = state.push("text", "", 0)
        token.content = "=="
        state.delimiters.append(
            Delimiter(
                marker=EQUALS,
                length=0,
                token=len(state.tokens) - 1,
                end=-1,
                open=scanned.can_open,
                close=scanned.can_close,
            )
        )
    state.pos += scanned.length
    return True


def _mark_pairs(state: StateInline, delimiters: list[Delimiter]) -> None:
    lone = []
    for start in delimiters:
        if start.marker != EQUALS or start.end == -1:
            continue
        end = delimiters[start.end]
        for index, kind, nesting in ((start.token, "mark_open", 1), (end.token, "mark_close", -1)):
            token = state.tokens[index]
            token.type, token.tag, token.nesting = kind, "mark", nesting
            token.markup, token.content = "==", ""
        before = state.tokens[end.token - 1]
        if before.type == "text" and before.content == "=":
            lone.append(end.token - 1)
    # An odd run (`===`) leaves one `=` before the closer; move it outside.
    while lone:
        i = lone.pop()
        j = i + 1
        while j < len(state.tokens) and state.tokens[j].type == "mark_close":
            j += 1
        j -= 1
        if i != j:
            state.tokens[i], state.tokens[j] = state.tokens[j], state.tokens[i]


def _mark_post_process(state: StateInline) -> None:
    _mark_pairs(state, state.delimiters)
    for meta in state.tokens_meta:
        if meta and "delimiters" in meta:
            _mark_pairs(state, meta["delimiters"])


def mark_plugin(md: MarkdownIt) -> None:
    """``==highlighted text==`` as ``<mark>``, parsed like ``~~strikethrough~~``."""
    md.inline.ruler.before("emphasis", "mark", _mark_tokenize)
    md.inline.ruler2.before("emphasis", "mark", _mark_post_process)


CODE_STYLE = "default"


def _highlight(code: str, lang: str, _attrs) -> str:
    try:
        lexer = get_lexer_by_name(lang) if lang else None
    except ClassNotFound:
        lexer = None
    if lexer is None:
        return ""  # markdown-it escapes it as plain code
    return pygments_highlight(code, lexer, HtmlFormatter(nowrap=True))


@lru_cache(maxsize=1)
def parser() -> MarkdownIt:
    md = MarkdownIt(
        "gfm-like",
        {"html": False, "typographer": True, "highlight": _highlight},
    )
    md.enable(["replacements", "smartquotes"])
    return md.use(mark_plugin).use(footnote_plugin).use(tasklists_plugin)


def render_html(source: str) -> str:
    return parser().render(source)


def code_css() -> str:
    """CSS for highlighted code in rendered HTML (Pygments' class names).

    Only the token colours: the code block's own background comes from the page.
    """
    rules = HtmlFormatter(style=CODE_STYLE).get_style_defs("pre code").splitlines()
    return "\n".join(rule for rule in rules if rule.startswith("pre code ."))
