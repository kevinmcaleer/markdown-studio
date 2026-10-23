"""Field types: what each one stores, its options, and turning input into values.

Values are kept in JSON (``tb_rows.data``), one per field, in a form that
sorts and compares correctly in SQLite:

=========  ==========================================  =====================
type       stored as                                   options
=========  ==========================================  =====================
text       string
long_text  string (may hold new lines)
number     number                                      decimals (shown)
currency   number                                      symbol, decimals
date       "YYYY-MM-DD"
datetime   "YYYY-MM-DDTHH:MM"
checkbox   true / false
choice     one of the choices' names                   choices: [{name, color}]
email      string with an @
url        string starting http:// or https://
link       the linked row's id, in another table       table_id
=========  ==========================================  =====================

Every type also takes ``required`` and ``description``. An empty value
(None, or a blank string) is never stored: the key is left out instead.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from datetime import date, datetime
from typing import Any

TYPES = (
    "text",
    "long_text",
    "number",
    "currency",
    "date",
    "datetime",
    "checkbox",
    "choice",
    "email",
    "url",
    "link",
)
TEXT_TYPES = {"text", "long_text", "email", "url", "choice"}
NUMBER_TYPES = {"number", "currency"}
DATE_TYPES = {"date", "datetime"}

MAX_TEXT = 100_000
MAX_CHOICES = 200
COLORS = ("grey", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink")

TRUE_WORDS = {"true", "yes", "y", "1", "x", "on", "checked", "✓", "✔"}
FALSE_WORDS = {"false", "no", "n", "0", "off", "unchecked"}

_NUMBER_JUNK = re.compile(r"[\s,£$€¥_']")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_ISO_DATE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_DMY = re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$")
_TIME = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([ap]m)?$", re.IGNORECASE)


class InvalidValue(ValueError):
    """A value that doesn't fit its field; the message is shown to the user."""


# ------------------------------------------------------------------ options


def clean_options(type_: str, options: dict | None, table_ids: set[int] | None = None) -> dict:
    """The options a field of ``type_`` keeps, checked. Unknown keys are dropped."""
    if type_ not in TYPES:
        raise InvalidValue(f"There's no field type called {type_}.")
    options = options or {}
    out: dict[str, Any] = {}
    if options.get("required"):
        out["required"] = True
    description = str(options.get("description") or "").strip()
    if description:
        out["description"] = description[:500]
    if type_ in NUMBER_TYPES:
        decimals = options.get("decimals", 2 if type_ == "currency" else None)
        if decimals is not None:
            try:
                out["decimals"] = max(0, min(10, int(decimals)))
            except (TypeError, ValueError):
                raise InvalidValue("Decimal places must be a whole number.") from None
    if type_ == "currency":
        out["symbol"] = str(options.get("symbol") or "£")[:4]
    if type_ == "choice":
        seen: set[str] = set()
        choices = []
        for i, choice in enumerate(options.get("choices") or []):
            raw = choice.get("name") if isinstance(choice, dict) else choice
            name = str(raw or "").strip()[:100]
            if not name or name.lower() in seen:
                continue
            seen.add(name.lower())
            color = choice.get("color") if isinstance(choice, dict) else None
            choices.append({"name": name, "color": color if color in COLORS else _color(i)})
        if len(choices) > MAX_CHOICES:
            raise InvalidValue(f"A choice field can have at most {MAX_CHOICES} choices.")
        out["choices"] = choices
    if type_ == "link":
        try:
            table_id = int(options.get("table_id"))
        except (TypeError, ValueError):
            raise InvalidValue("Pick the table this field links to.") from None
        if table_ids is not None and table_id not in table_ids:
            raise InvalidValue("That table isn't in this database.")
        out["table_id"] = table_id
    return out


def _color(i: int) -> str:
    return COLORS[1:][i % (len(COLORS) - 1)]


def add_choices(options: dict, names: list[str]) -> dict:
    """``options`` with any of ``names`` that aren't choices yet added at the end."""
    choices = list(options.get("choices") or [])
    have = {c["name"].lower() for c in choices}
    for name in names:
        name = name.strip()[:100]
        if name and name.lower() not in have:
            have.add(name.lower())
            choices.append({"name": name, "color": _color(len(choices))})
    return {**options, "choices": choices[:MAX_CHOICES]}


# ------------------------------------------------------------------- values


def is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def coerce(
    type_: str,
    options: dict,
    value: Any,
    find_link: Callable[[Any], int | None] | None = None,
) -> Any:
    """``value`` as ``type_`` stores it, or None for empty. Raises InvalidValue.

    Strings are accepted for every type, so pasted and imported text works.
    ``find_link`` resolves a link field's input (a row id, or the linked row's
    name) to a row id in the linked table.
    """
    if is_empty(value):
        return None
    if type_ in ("text", "long_text"):
        text = value if isinstance(value, str) else to_text(type_, options, value)
        if type_ == "text":
            text = " ".join(text.split("\n")).strip()
        if len(text) > MAX_TEXT:
            raise InvalidValue(f"Text can be at most {MAX_TEXT:,} characters.")
        return text
    if type_ in NUMBER_TYPES:
        return parse_number(value)
    if type_ == "date":
        return parse_date(value)
    if type_ == "datetime":
        return parse_datetime(value)
    if type_ == "checkbox":
        return parse_bool(value)
    if type_ == "choice":
        name = str(value).strip()
        for choice in options.get("choices") or []:
            if choice["name"].lower() == name.lower():
                return choice["name"]
        raise InvalidValue(f"{name} isn't one of the choices.")
    if type_ == "email":
        email = str(value).strip()
        if not _EMAIL.match(email):
            raise InvalidValue(f"{email} isn't an email address.")
        return email
    if type_ == "url":
        url = str(value).strip()
        if not re.match(r"^https?://", url, re.IGNORECASE):
            if " " in url or "." not in url:
                raise InvalidValue(f"{url} isn't a web address.")
            url = "https://" + url
        return url
    if type_ == "link":
        found = find_link(value) if find_link else None
        if found is None:
            raise InvalidValue(f"There's no row {value} in the linked table.")
        return found
    raise InvalidValue(f"There's no field type called {type_}.")


def parse_number(value: Any) -> int | float:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int | float):
        number = value
    else:
        text = _NUMBER_JUNK.sub("", str(value).strip())
        negative = text.startswith("(") and text.endswith(")")
        text = text.strip("()")
        percent = text.endswith("%")
        text = text.rstrip("%")
        try:
            number = float(text)
        except ValueError:
            raise InvalidValue(f"{value} isn't a number.") from None
        if negative:
            number = -number
        if percent:
            number = number / 100
    if isinstance(number, float):
        if not math.isfinite(number):
            raise InvalidValue(f"{value} isn't a number.")
        if number.is_integer() and abs(number) < 2**53:
            return int(number)
    return number


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value != 0
    word = str(value).strip().lower()
    if word in TRUE_WORDS:
        return True
    if word in FALSE_WORDS:
        return False
    raise InvalidValue(f"{value} isn't yes or no.")


def parse_date(value: Any) -> str:
    """A date as YYYY-MM-DD. Takes ISO, or day/month/year as written in the UK."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    # A date and time: keep the date.
    text = re.split(r"[T ]", text, maxsplit=1)[0] if re.match(r"^\d{4}-", text) else text
    if m := _ISO_DATE.match(text):
        y, mo, d = (int(g) for g in m.groups())
    elif m := _DMY.match(text):
        d, mo, y = (int(g) for g in m.groups())
        if y < 100:
            y += 2000 if y < 70 else 1900
    else:
        raise InvalidValue(f"{value} isn't a date. Write it as 2026-12-31 or 31/12/2026.")
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        raise InvalidValue(f"{value} isn't a date.") from None


def parse_datetime(value: Any) -> str:
    """A date and time as YYYY-MM-DDTHH:MM (no time zone: as the user wrote it)."""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%dT%H:%M")
    text = str(value).strip()
    parts = re.split(r"[T ]+", text, maxsplit=1)
    day = parse_date(parts[0])
    hours = minutes = 0
    if len(parts) > 1:
        clock = re.sub(r"(Z|[+-]\d{2}:?\d{2})$", "", parts[1].strip())
        m = _TIME.match(clock)
        if not m:
            raise InvalidValue(f"{value} isn't a date and time.")
        hours, minutes = int(m.group(1)), int(m.group(2))
        meridiem = (m.group(4) or "").lower()
        if meridiem == "pm" and hours < 12:
            hours += 12
        elif meridiem == "am" and hours == 12:
            hours = 0
        if hours > 23 or minutes > 59:
            raise InvalidValue(f"{value} isn't a time of day.")
    return f"{day}T{hours:02d}:{minutes:02d}"


def _date_only(value: Any) -> str:
    """A date with no time of day (for guessing a column's type)."""
    if re.search(r"\d:\d", str(value)):
        raise InvalidValue(f"{value} has a time.")
    return parse_date(value)


def to_text(type_: str, options: dict, value: Any, link_label: str | None = None) -> str:
    """A stored value as plain text: for CSV export and for changing a field's type."""
    if value is None:
        return ""
    if type_ == "checkbox":
        return "Yes" if value else "No"
    if type_ in NUMBER_TYPES:
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        return str(value)
    if type_ == "datetime":
        return str(value).replace("T", " ")
    if type_ == "link":
        return link_label if link_label is not None else str(value)
    return str(value)


def sort_family(type_: str) -> str:
    """How a field's values compare: as text (ignoring case), numbers, dates or yes/no."""
    if type_ in NUMBER_TYPES:
        return "number"
    if type_ in DATE_TYPES:
        return "date"
    if type_ == "checkbox":
        return "checkbox"
    return "text"


def guess_type(values: list[str]) -> str:
    """The narrowest type every non-empty value fits, for imported columns."""
    sample = [v for v in values if not is_empty(v)][:1000]
    if not sample:
        return "text"
    for type_, check in (
        ("checkbox", parse_bool),
        ("number", parse_number),
        ("date", _date_only),
        ("datetime", parse_datetime),
        ("email", lambda v: coerce("email", {}, v)),
    ):
        try:
            for v in sample:
                check(v)
        except InvalidValue:
            continue
        # A column of 0s and 1s is more likely numbers than yes/no.
        if type_ == "checkbox" and all(str(v).strip() in {"0", "1"} for v in sample):
            continue
        return type_
    if any("\n" in v or len(v) > 255 for v in sample):
        return "long_text"
    return "text"
