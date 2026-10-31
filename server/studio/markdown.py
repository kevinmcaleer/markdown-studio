"""The server's Markdown parser, matching the editor's preview.

Same dialect as ``web/src/notes/markdown.ts``: CommonMark plus GFM tables,
strikethrough, autolinks and task lists, footnotes, typographic quotes, and
``==highlight==``. Raw HTML in a note is shown as text, never passed through.
"""

from __future__ import annotations

import re
from functools import lru_cache

from markdown_it import MarkdownIt
from markdown_it.rules_core import StateCore
from markdown_it.rules_inline.state_inline import Delimiter, StateInline
from markdown_it.token import Token
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


# ------------------------------------------------- tables, as the editor writes them
#
# The editor's table features, kept in plain GFM (see the editor package's
# cellHeadings.ts and tableWidths.ts, which these follow):
#
# - ``<br>`` in a cell starts a new line (Shift+Enter in a cell types it).
# - A line in a cell that starts with #'s is a heading.
# - The delimiter row's dash counts are the columns' widths (``| ----- | --------------- |``
#   is 25% and 75%); equal counts set none.

BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
HASHES_RE = re.compile(r"^\s*(#{1,6})[ \t]+")
DELIMITER_CELL_RE = re.compile(r"^:?-+:?$")


def _br_tag(state: StateInline, silent: bool) -> bool:
    """``<br>`` (``<br/>``, ``<br />``) is a line break, even with raw HTML off."""
    match = BR_RE.match(state.src, state.pos, state.pos + 8)
    if not match:
        return False
    if not silent:
        state.push("hardbreak", "br", 0)
    state.pos = match.end()
    return True


def _cell_lines(children: list[Token]) -> list[Token]:
    """A cell's inline tokens split into lines, with the ones that start with #'s as headings."""
    lines: list[list[Token]] = [[]]
    for i, token in enumerate(children):
        if token.type in ("hardbreak", "softbreak"):
            lines.append([])
            continue
        after_image = i > 0 and children[i - 1].type == "image"
        if (
            token.type == "text"
            and after_image
            and HASHES_RE.match(token.content)
            and token.content.strip().lstrip("#")
        ):
            lines.append([])
        lines[-1].append(token)

    def level_of(line: list[Token]) -> int:
        first = line[0] if line else None
        match = HASHES_RE.match(first.content) if first and first.type == "text" else None
        if match and (first.content[match.end() :].strip() or len(line) > 1):
            return len(match.group(1))
        return 0

    if len(lines) == 1 and not level_of(lines[0]):
        return children

    out: list[Token] = []
    last_heading = True
    for index, line in enumerate(lines):
        level = level_of(line)
        first = line[0] if line else None
        last = line[-1] if line else None
        if level:
            first.content = HASHES_RE.sub("", first.content, count=1)
            if last.type == "text":
                last.content = re.sub(r"(?:[ \t]+#+)?[ \t]*$", "", last.content)
            opener = Token("heading_open", f"h{level}", 1)
            opener.attrSet("class", "cell-heading")
            out += [opener, *line, Token("heading_close", f"h{level}", -1)]
            last_heading = True
        else:
            if first is not None and first.type == "text":
                first.content = first.content.lstrip()
            if last is not None and last.type == "text":
                last.content = last.content.rstrip()
            if index > 0 and not last_heading:
                out.append(Token("hardbreak", "br", 0))
            out += line
            last_heading = False
    return out


def _cell_headings(state: StateCore) -> None:
    in_table = False
    tokens = state.tokens
    for i, token in enumerate(tokens):
        if token.type == "table_open":
            in_table = True
        elif token.type == "table_close":
            in_table = False
        if not in_table or token.type not in ("th_open", "td_open") or i + 1 >= len(tokens):
            continue
        inline = tokens[i + 1]
        if inline.type == "inline" and inline.children:
            inline.children = _cell_lines(inline.children)


def delimiter_dashes(line: str) -> list[int] | None:
    """The dash count of each cell on a delimiter line (quote markers allowed), or None."""
    text = re.sub(r"^\s*(?:>\s?)*", "", line).strip()
    text = text.removeprefix("|").removesuffix("|")
    cells = [cell.strip() for cell in text.split("|")]
    if not cells or not all(DELIMITER_CELL_RE.match(cell) for cell in cells):
        return None
    return [len(cell.replace(":", "")) for cell in cells]


def column_widths(dashes: list[int] | None) -> list[float] | None:
    """Each column's width in percent, or None when the dash counts are all the same."""
    if not dashes or len(dashes) < 2 or all(n == dashes[0] for n in dashes):
        return None
    total = sum(dashes)
    return [n / total * 100 for n in dashes]


def _table_widths(state: StateCore) -> None:
    lines = state.src.split("\n")
    tokens = state.tokens
    for i, token in enumerate(tokens):
        if token.type != "table_open" or not token.map:
            continue
        row = token.map[0] + 1
        dashes = delimiter_dashes(lines[row] if row < len(lines) else "")
        columns = 0
        for later in tokens[i + 1 :]:
            if later.type == "tr_close":
                break
            columns += later.type == "th_open"
        # The header row's cell count must match, or the line isn't this table's.
        widths = column_widths(dashes) if dashes and len(dashes) == columns else None
        if widths:
            token.attrJoin("class", "has-widths")
            token.meta["widths"] = widths


def _render_table_open(self, tokens: list[Token], idx: int, options, env) -> str:
    out = self.renderToken(tokens, idx, options, env)
    widths = tokens[idx].meta.get("widths")
    if widths:
        cols = "".join(f'<col style="width: {round(w, 2):g}%">' for w in widths)
        out += f"<colgroup>{cols}</colgroup>\n"
    return out


def table_plugin(md: MarkdownIt) -> None:
    """``<br>`` and heading lines in cells, and column widths from the dash counts."""
    md.inline.ruler.before("autolink", "br_tag", _br_tag)
    md.core.ruler.push("cell_headings", _cell_headings)
    md.core.ruler.push("table_widths", _table_widths)
    md.add_render_rule("table_open", _render_table_open)


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
    return md.use(mark_plugin).use(footnote_plugin).use(tasklists_plugin).use(table_plugin)


def render_html(source: str) -> str:
    return parser().render(source)


def code_css() -> str:
    """CSS for highlighted code in rendered HTML (Pygments' class names).

    Only the token colours: the code block's own background comes from the page.
    """
    rules = HtmlFormatter(style=CODE_STYLE).get_style_defs("pre code").splitlines()
    return "\n".join(rule for rule in rules if rule.startswith("pre code ."))
