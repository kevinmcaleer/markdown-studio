"""Three-way merging of text, line by line, and the sync decision built on it.

:func:`merge3` is diff3: it takes the text both sides started from and each
side's edits, keeps every edit that doesn't touch lines the other side also
changed, and marks the rest as conflicts.

:func:`plan` decides what a sync does with a note and its copy elsewhere
(push, pull, merge or conflict). It is pure, so every case is easy to test.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

OURS_LABEL = "Markdown Studio"


@dataclass(frozen=True)
class Merged:
    text: str
    clean: bool


def _lines(text: str) -> list[str]:
    lines = text.splitlines(keepends=True)
    # Without this, "x" and "x\n" are different last lines and conflict.
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    return lines


def _hunks(base: list[str], other: list[str]) -> list[tuple[int, int, list[str]]]:
    """Each change as (start, end) in base and the lines that replace base[start:end]."""
    matcher = SequenceMatcher(None, base, other, autojunk=False)
    return [
        (i1, i2, other[j1:j2]) for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag != "equal"
    ]


def merge3(base: str, ours: str, theirs: str, theirs_label: str = "theirs") -> Merged:
    """Merge two edited copies of ``base``.

    Changes to the same lines (or insertions at the same place) conflict
    unless both sides made the same change; changes to neighbouring lines
    don't, so two people can edit consecutive paragraphs. Conflicts are
    written with git-style markers.
    """
    if ours == theirs:
        return Merged(ours, True)
    if ours == base:
        return Merged(theirs, True)
    if theirs == base:
        return Merged(ours, True)
    old = _lines(base)
    changes = sorted(
        [(s, e, lines, 0) for s, e, lines in _hunks(old, _lines(ours))]
        + [(s, e, lines, 1) for s, e, lines in _hunks(old, _lines(theirs))],
        key=lambda h: (h[0], h[1]),
    )

    def apply(hunks: list, start: int, end: int, side: int) -> list[str]:
        result, at = [], start
        for s, e, lines, who in hunks:
            if who == side:
                result += old[at:s] + lines
                at = e
        return result + old[at:end]

    out: list[str] = []
    clean = True
    at = i = 0
    while i < len(changes):
        start, end = changes[i][0], changes[i][1]
        j = i + 1
        while j < len(changes) and any(_overlap(changes[j], h) for h in changes[i:j]):
            end = max(end, changes[j][1])
            j += 1
        group = changes[i:j]
        out += old[at:start]
        mine, yours = apply(group, start, end, 0), apply(group, start, end, 1)
        sides = {who for *_, who in group}
        if len(sides) == 1:
            out += mine if 0 in sides else yours
        elif mine == yours:
            out += mine
        else:
            clean = False
            out += [
                f"<<<<<<< {OURS_LABEL}\n",
                *mine,
                "=======\n",
                *yours,
                f">>>>>>> {theirs_label}\n",
            ]
        at, i = end, j
    out += old[at:]
    text = "".join(out)
    # Keep a missing final newline missing, as long as both sides agree.
    if not ours.endswith("\n") and not theirs.endswith("\n") and text.endswith("\n"):
        text = text[:-1]
    return Merged(text, clean)


def _overlap(a: tuple, b: tuple) -> bool:
    """Whether two changes (start, end, ...) in base touch the same lines."""
    (s1, e1), (s2, e2) = a[:2], b[:2]
    if s1 == e1 and s2 == e2:  # two insertions
        return s1 == s2
    if s1 == e1:  # an insertion inside the other change
        return s2 < s1 < e2
    if s2 == e2:
        return s1 < s2 < e1
    return s1 < e2 and s2 < e1


@dataclass(frozen=True)
class Plan:
    """What a sync does.

    ``outcome`` is ``unchanged``, ``pushed``, ``pulled``, ``merged`` or
    ``conflict``. ``local`` is the note's new text (for a conflict: the text
    with conflict markers, which is only applied if someone asks for it), and
    ``push`` says whether the copy needs ``local`` sent to it.
    """

    outcome: str
    local: str
    push: bool


def plan(base: str, remote_base: str, local: str, remote: str, remote_label: str) -> Plan:
    """Decide how to bring the note (``local``) and its copy (``remote``) together.

    ``base`` and ``remote_base`` are what each side looked like at the last
    sync. They can differ when the copy's format rewrites Markdown slightly,
    so a change is judged against each side's own base.
    """
    local_changed = local != base
    if remote == remote_base:
        return Plan("pushed" if local_changed else "unchanged", local, local_changed)
    # Their edits, replayed on our own last text, so the copy's rewriting of
    # lines nobody touched doesn't show up as a change.
    replayed = merge3(remote_base, base, remote)
    theirs = replayed.text if replayed.clean else remote
    if not local_changed:
        return Plan("pulled" if theirs != local else "unchanged", theirs, False)
    if theirs == local:
        return Plan("unchanged", local, False)
    merged = merge3(base, local, theirs, remote_label)
    if merged.clean:
        return Plan("merged", merged.text, merged.text != theirs)
    return Plan("conflict", merged.text, False)
