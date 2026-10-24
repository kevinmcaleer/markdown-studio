from __future__ import annotations

from studio.merge import merge3, plan

BASE = "# Plan\n\nIntro line.\n\nMiddle line.\n\nLast line.\n"


def test_merges_edits_to_different_lines():
    ours = BASE.replace("Intro line.", "Intro, edited here.")
    theirs = BASE.replace("Last line.", "Last, edited there.")
    merged = merge3(BASE, ours, theirs)
    assert merged.clean
    assert "Intro, edited here." in merged.text
    assert "Last, edited there." in merged.text


def test_same_edit_on_both_sides_is_not_a_conflict():
    both = BASE.replace("Middle", "Centre")
    assert merge3(BASE, both, both) == merge3(BASE, both, both)
    assert merge3(BASE, both, both).text == both
    assert merge3(BASE, both + "more\n", both).text == both + "more\n"


def test_clashing_edits_are_marked():
    ours = BASE.replace("Middle line.", "Middle, mine.")
    theirs = BASE.replace("Middle line.", "Middle, theirs.")
    merged = merge3(BASE, ours, theirs, "Google Docs")
    assert not merged.clean
    assert (
        "<<<<<<< Markdown Studio\nMiddle, mine.\n=======\nMiddle, theirs.\n>>>>>>> Google Docs\n"
        in merged.text
    )
    assert merged.text.startswith("# Plan\n\nIntro line.\n")
    assert merged.text.endswith("Last line.\n")


def test_insertions_and_deletions():
    ours = BASE.replace("Intro line.\n\n", "")
    theirs = BASE + "\nAppendix.\n"
    merged = merge3(BASE, ours, theirs)
    assert merged.clean
    assert merged.text == "# Plan\n\nMiddle line.\n\nLast line.\n\nAppendix.\n"


def test_missing_final_newline():
    merged = merge3("a\nb", "a!\nb", "a\nb?")
    assert merged.clean
    assert merged.text == "a!\nb?"


def test_plan_push_pull_and_nothing():
    assert plan(BASE, BASE, BASE, BASE, "G").outcome == "unchanged"
    pushed = plan(BASE, BASE, BASE + "x\n", BASE, "G")
    assert (pushed.outcome, pushed.push) == ("pushed", True)
    pulled = plan(BASE, BASE, BASE, BASE + "y\n", "G")
    assert (pulled.outcome, pulled.local, pulled.push) == ("pulled", BASE + "y\n", False)


def test_plan_merges_and_pushes_the_merge():
    local = BASE.replace("Intro", "Opening")
    remote = BASE.replace("Last", "Final")
    result = plan(BASE, BASE, local, remote, "G")
    assert result.outcome == "merged"
    assert result.push
    assert "Opening" in result.local and "Final" in result.local


def test_plan_conflict():
    result = plan(BASE, BASE, BASE.replace("Middle", "A"), BASE.replace("Middle", "B"), "G")
    assert result.outcome == "conflict"
    assert ">>>>>>> G" in result.local


def test_remote_rewrites_are_not_edits():
    """Google writes `* item` for `- item`; that alone must never change the note."""
    base = "- one\n- two\n\nText.\n"
    remote_base = "* one\n* two\n\nText.\n"
    # Nobody edited the copy: the note's own edits are pushed.
    local = base.replace("Text.", "Text, edited.")
    result = plan(base, remote_base, local, remote_base, "G")
    assert (result.outcome, result.local) == ("pushed", local)
    # Someone edited the copy: only that edit comes back, in the note's own style.
    remote = remote_base + "\nNew paragraph.\n"
    result = plan(base, remote_base, base, remote, "G")
    assert (result.outcome, result.local) == ("pulled", base + "\nNew paragraph.\n")
    # Both edited different places: merged, still in the note's style.
    result = plan(base, remote_base, local, remote, "G")
    assert result.outcome == "merged"
    assert result.local == local + "\nNew paragraph.\n"
