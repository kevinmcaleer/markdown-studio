from __future__ import annotations

import csv
import io
import json

import pytest
from conftest import Client

from studio.tables import query as q
from studio.tables import types as ft


def patch(client, url, body, **headers):
    return client.patch(url, json=body, headers={"X-CSRF-Token": client.csrf, **headers})


def delete(client, url, **headers):
    return client.delete(url, headers={"X-CSRF-Token": client.csrf, **headers})


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def new_db(c, name="Contacts"):
    return ok(c.post_json("/api/tables/databases", {"name": name}))["database"]


def schema(c, db_id):
    return ok(c.get(f"/api/tables/{db_id}"))


def add_field(c, db_id, table_id, name, type_, options=None):
    data = ok(
        c.post_json(
            f"/api/tables/{db_id}/tables/{table_id}/fields",
            {"name": name, "type": type_, "options": options or {}},
        )
    )
    return data["field_id"]


def add_rows(c, db_id, table_id, rows, **extra):
    return ok(c.post_json(f"/api/tables/{db_id}/tables/{table_id}/rows", {"rows": rows, **extra}))


def view(c, db_id, table_id, **body):
    return ok(c.post_json(f"/api/tables/{db_id}/tables/{table_id}/rows/query", body))


@pytest.fixture
def people(user_client):
    """A database with a People table: Name (text), Age (number), Joined (date), Member (yes/no)."""
    c = user_client
    db = new_db(c)
    s = schema(c, db["id"])
    table = s["tables"][0]
    name_id = table["fields"][0]["id"]
    age = add_field(c, db["id"], table["id"], "Age", "number")
    joined = add_field(c, db["id"], table["id"], "Joined", "date")
    member = add_field(c, db["id"], table["id"], "Member", "checkbox")
    add_rows(
        c,
        db["id"],
        table["id"],
        [
            {str(name_id): "Ada", str(age): "36", str(joined): "10/12/2025", str(member): "yes"},
            {str(name_id): "bob", str(age): 25, str(joined): "2026-01-05", str(member): False},
            {str(name_id): "Cleo", str(age): "41.5", str(member): "x"},
            {str(name_id): "Dan"},
        ],
    )
    return (
        c,
        db["id"],
        table["id"],
        {"name": name_id, "age": age, "joined": joined, "member": member},
    )


def names(result, key):
    return [r["values"].get(str(key)) for r in result["rows"]]


# ------------------------------------------------------------------ types


def test_values_are_read_from_text_as_their_type():
    assert ft.coerce("number", {}, "1,234.50") == 1234.5
    assert ft.coerce("currency", {}, "£12") == 12
    assert ft.coerce("number", {}, "(5)") == -5
    assert ft.coerce("number", {}, "50%") == 0.5
    assert ft.coerce("date", {}, "31/12/2026") == "2026-12-31"
    assert ft.coerce("date", {}, "2026-02-03T10:00:00Z") == "2026-02-03"
    assert ft.coerce("datetime", {}, "2026-02-03 3:05 pm") == "2026-02-03T15:05"
    assert ft.coerce("checkbox", {}, "Yes") is True
    assert ft.coerce("url", {}, "example.com") == "https://example.com"
    assert ft.coerce("text", {}, "two\nlines") == "two lines"
    assert ft.coerce("long_text", {}, "two\nlines") == "two\nlines"
    assert ft.coerce("text", {}, "   ") is None
    choices = {"choices": [{"name": "Open", "color": "green"}]}
    assert ft.coerce("choice", choices, "open") == "Open"
    for type_, bad in [
        ("number", "abc"),
        ("date", "31/02/2026"),
        ("email", "nope"),
        ("choice", "Closed"),
        ("checkbox", "maybe"),
    ]:
        with pytest.raises(ft.InvalidValue):
            ft.coerce(type_, choices, bad)


def test_imported_columns_get_the_narrowest_type():
    assert ft.guess_type(["1", "2.5", ""]) == "number"
    assert ft.guess_type(["0", "1"]) == "number"
    assert ft.guess_type(["yes", "no"]) == "checkbox"
    assert ft.guess_type(["2026-01-01", "31/12/2025"]) == "date"
    assert ft.guess_type(["2026-01-01 10:00"]) == "datetime"
    assert ft.guess_type(["a@b.co"]) == "email"
    assert ft.guess_type(["hello"]) == "text"
    assert ft.guess_type([]) == "text"


# --------------------------------------------------------------- database


def test_a_database_is_a_file_with_a_starter_table(user_client):
    c = user_client
    db = new_db(c, "Inventory")
    assert db["name"] == "Inventory.tables"
    tree = ok(c.get("/api/files"))
    assert tree["files"][0]["mime_type"] == "application/vnd.markdown-studio.tables+json"
    s = schema(c, db["id"])
    assert s["role"] == "owner"
    assert [t["name"] for t in s["tables"]] == ["Table 1"]
    assert [(f["name"], f["type"]) for f in s["tables"][0]["fields"]] == [
        ("Name", "text"),
        ("Notes", "long_text"),
    ]
    listed = ok(c.get("/api/tables/databases"))
    assert [d["id"] for d in listed["databases"]] == [db["id"]]
    # A note isn't a database.
    note = ok(c.post_json("/api/files", {"name": "Plan"}))["file"]
    assert c.get(f"/api/tables/{note['id']}").status_code == 415
    # Renaming keeps it a database.
    ok(patch(c, f"/api/files/{db['id']}", {"name": "Stock.tables"}))
    assert schema(c, db["id"])["database"]["name"] == "Stock.tables"


def test_tables_need_sign_in_or_a_share(client, user_client):
    db = new_db(user_client)
    with Client(client.app) as other:
        other.refresh()
        assert other.get(f"/api/tables/{db['id']}").status_code == 401
        assert other.register("sam").status_code == 200
        assert other.get(f"/api/tables/{db['id']}").status_code == 404


def test_rows_store_values_as_their_type(people):
    c, db, table, f = people
    result = view(c, db, table)
    assert result["total"] == 4
    assert [r["number"] for r in result["rows"]] == [1, 2, 3, 4]
    ada = result["rows"][0]["values"]
    assert ada[str(f["age"])] == 36
    assert ada[str(f["joined"])] == "2025-12-10"
    assert ada[str(f["member"])] is True
    assert result["rows"][2]["values"][str(f["age"])] == 41.5
    keys = [col["key"] for col in result["columns"]]
    assert keys == [str(f["name"]), *[k for k in keys if k != str(f["name"])]]


def test_bad_values_are_refused_with_a_reason(people):
    c, db, table, f = people
    row = view(c, db, table)["rows"][0]
    response = patch(
        c,
        f"/api/tables/{db}/tables/{table}/rows",
        {"updates": [{"id": row["id"], "values": {str(f["age"]): "old"}}]},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Age: old isn't a number."


def test_editing_cells_and_clearing_them(people):
    c, db, table, f = people
    rows = view(c, db, table)["rows"]
    before = schema(c, db)["revision"]
    updated = ok(
        patch(
            c,
            f"/api/tables/{db}/tables/{table}/rows",
            {
                "updates": [
                    {"id": rows[0]["id"], "values": {str(f["name"]): "Ada L", str(f["age"]): ""}},
                    {"id": rows[1]["id"], "values": {str(f["member"]): True}},
                ]
            },
        )
    )
    assert updated["revision"] > before
    assert updated["rows"][0]["values"][str(f["name"])] == "Ada L"
    assert updated["rows"][0]["values"][str(f["age"])] is None
    assert view(c, db, table)["rows"][1]["values"][str(f["member"])] is True


def test_required_fields(people):
    c, db, table, f = people
    ok(patch(c, f"/api/tables/{db}/fields/{f['name']}", {"options": {"required": True}}))
    # The datasheet can add an empty row to fill in, but a form can't save one.
    add_rows(c, db, table, [{}])
    response = c.post_json(f"/api/tables/{db}/tables/{table}/rows", {"rows": [{}], "strict": True})
    assert response.status_code == 422
    assert response.json()["detail"] == "Name can't be empty."
    row = view(c, db, table)["rows"][0]
    response = patch(
        c,
        f"/api/tables/{db}/tables/{table}/rows",
        {"updates": [{"id": row["id"], "values": {str(f["name"]): ""}}]},
    )
    assert response.status_code == 422


def test_delete_rows_keeps_numbers(people):
    c, db, table, _ = people
    rows = view(c, db, table)["rows"]
    deleted = ok(
        c.post_json(f"/api/tables/{db}/tables/{table}/rows/delete", {"ids": [rows[3]["id"]]})
    )
    assert deleted["deleted"] == 1
    # Like an autonumber, the next row's ID isn't reused.
    added = add_rows(c, db, table, [{}])
    assert added["rows"][0]["number"] == 5


# --------------------------------------------------- filters and sorting


def test_datasheet_filters_sort_and_search(people):
    c, db, table, f = people
    name = f["name"]

    def run(**body):
        return names(view(c, db, table, **body), name)

    assert run(sort=[{"field": name, "dir": "asc"}]) == ["Ada", "bob", "Cleo", "Dan"]
    assert run(sort=[{"field": f["age"], "dir": "desc"}]) == ["Cleo", "Ada", "bob", "Dan"]
    assert run(sort=[{"field": f["age"], "dir": "asc"}]) == ["bob", "Ada", "Cleo", "Dan"]
    assert run(filters=[{"field": f["age"], "op": ">", "value": "30"}]) == ["Ada", "Cleo"]
    assert run(filters=[{"field": name, "op": "contains", "value": "O"}]) == ["bob", "Cleo"]
    assert run(filters=[{"field": name, "op": "=", "value": "BOB"}]) == ["bob"]
    assert run(filters=[{"field": name, "op": "<>", "value": "bob"}]) == ["Ada", "Cleo", "Dan"]
    assert run(filters=[{"field": f["joined"], "op": "<", "value": "1/1/2026"}]) == ["Ada"]
    assert run(filters=[{"field": f["joined"], "op": "empty"}]) == ["Cleo", "Dan"]
    assert run(filters=[{"field": f["member"], "op": "notEmpty"}]) == ["Ada", "Cleo"]
    assert run(filters=[{"field": f["member"], "op": "=", "value": "no"}]) == ["bob", "Dan"]
    assert run(filters=[{"field": "id", "op": ">=", "value": "3"}]) == ["Cleo", "Dan"]
    both = [
        {"field": f["age"], "op": ">", "value": "30"},
        {"field": f["age"], "op": "<", "value": "40"},
    ]
    assert run(filters=both) == ["Ada"]
    assert run(filters=both, match="any") == ["Ada", "bob", "Cleo"]
    assert run(search="le") == ["Cleo"]
    # Search and filter values are data, never SQL.
    assert run(search="%") == []
    assert run(filters=[{"field": name, "op": "contains", "value": "'); DROP TABLE x;--"}]) == []
    response = c.post_json(
        f"/api/tables/{db}/tables/{table}/rows/query",
        {"filters": [{"field": f["age"], "op": ">", "value": "lots"}]},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Age holds numbers, and lots isn't one."


def test_paging(people):
    c, db, table, f = people
    page = view(c, db, table, offset=1, limit=2)
    assert page["total"] == 4 and page["offset"] == 1
    assert names(page, f["name"]) == ["bob", "Cleo"]


# ----------------------------------------------------------------- queries


def run_query(c, db, spec, **extra):
    return c.post_json(f"/api/tables/{db}/query", {"spec": spec, **extra})


def test_query_designer_criteria_rows_are_ored(people):
    c, db, table, f = people
    spec = {
        "table_id": table,
        "or_rows": 1,
        "fields": [
            {"field": f["name"], "sort": "desc"},
            {
                "field": f["age"],
                "criteria": {"op": ">", "value": "40"},
                "or": [{"op": "<", "value": "30"}],
            },
            {"field": f["member"], "show": False},
        ],
    }
    result = ok(run_query(c, db, spec))
    assert [col["name"] for col in result["columns"]] == ["Name", "Age"]
    assert names(result, f["name"]) == ["Cleo", "bob"]
    assert all(col["editable"] for col in result["columns"])
    # Each row's conditions are ANDed: no one over 40 is a non-member.
    spec["fields"][2]["criteria"] = {"op": "=", "value": "no"}
    assert names(ok(run_query(c, db, spec)), f["name"]) == ["bob"]
    spec["limit"] = 1
    spec["fields"][2].pop("criteria")
    limited = ok(run_query(c, db, spec))
    assert limited["total"] == 1 and names(limited, f["name"]) == ["Cleo"]


def test_query_totals_name_summaries_like_access(people):
    c, db, table, f = people
    spec = {
        "table_id": table,
        "totals": True,
        "fields": [
            {"field": f["member"], "total": "group", "sort": "asc"},
            {"field": f["age"], "total": "sum"},
            {"field": "id", "total": "count"},
            {"field": f["age"], "total": "max", "name": "Oldest"},
        ],
    }
    result = ok(run_query(c, db, spec))
    assert result["grouped"]
    assert [col["name"] for col in result["columns"]] == [
        "Member",
        "SumOfAge",
        "CountOfID",
        "Oldest",
    ]
    assert [list(r["values"].values()) for r in result["rows"]] == [
        [0, 25, 2, 25],
        [1, 77.5, 2, 41.5],
    ]
    # Criteria on a summary filter the groups.
    spec["fields"][2]["criteria"] = {"op": ">", "value": "1"}
    spec["fields"][1]["criteria"] = {"op": ">", "value": "50"}
    assert len(ok(run_query(c, db, spec))["rows"]) == 1
    # A Where field filters rows before grouping.
    spec["fields"][1].pop("criteria")
    spec["fields"][2].pop("criteria")
    spec["fields"].append(
        {"field": f["name"], "total": "where", "criteria": {"op": "<>", "value": "Dan"}}
    )
    rows = ok(run_query(c, db, spec))["rows"]
    assert [r["values"]["c2"] for r in rows] == [1, 2]
    # Summing text makes no sense.
    spec["fields"].append({"field": f["name"], "total": "sum"})
    response = run_query(c, db, spec)
    assert response.status_code == 422
    assert response.json()["detail"].startswith("Sum needs numbers, and Name isn't")


def test_saved_queries_and_forms(people):
    c, db, table, f = people
    spec = {"table_id": table, "fields": [{"field": f["name"]}]}
    created = ok(
        c.post_json(f"/api/tables/{db}/objects", {"kind": "query", "name": "Names", "spec": spec})
    )
    again = ok(
        c.post_json(f"/api/tables/{db}/objects", {"kind": "query", "name": "names", "spec": spec})
    )
    assert [o["name"] for o in again["queries"]] == ["Names", "names 2"]
    form = ok(
        c.post_json(f"/api/tables/{db}/objects", {"kind": "form", "spec": {"table_id": table}})
    )
    assert [o["name"] for o in form["forms"]] == ["Form"]
    oid = created["object_id"]
    changed = ok(patch(c, f"/api/tables/{db}/objects/{oid}", {"name": "People"}))
    assert "People" in [o["name"] for o in changed["queries"]]
    bad = c.post_json(f"/api/tables/{db}/objects", {"kind": "query", "spec": {"table_id": 999}})
    assert bad.status_code == 422
    ok(delete(c, f"/api/tables/{db}/objects/{oid}"))
    assert len(schema(c, db)["queries"]) == 1


# -------------------------------------------------------- design changes


def test_changing_a_field_type_converts_values(people):
    c, db, table, f = people
    dry = ok(patch(c, f"/api/tables/{db}/fields/{f['name']}", {"type": "number", "dry_run": True}))
    assert dry == {"lost": 4, "examples": ["Ada", "bob", "Cleo", "Dan"]}
    assert view(c, db, table)["rows"][0]["values"][str(f["name"])] == "Ada"
    # Number to text and back keeps every value.
    ok(patch(c, f"/api/tables/{db}/fields/{f['age']}", {"type": "text"}))
    assert names(view(c, db, table), f["age"]) == ["36", "25", "41.5", None]
    result = ok(patch(c, f"/api/tables/{db}/fields/{f['age']}", {"type": "number"}))
    assert result["lost"] == 0
    assert names(view(c, db, table), f["age"]) == [36, 25, 41.5, None]
    # Text to a choice field: its values become the choices.
    ok(patch(c, f"/api/tables/{db}/fields/{f['name']}", {"type": "choice"}))
    field = next(x for x in schema(c, db)["tables"][0]["fields"] if x["id"] == f["name"])
    assert [ch["name"] for ch in field["options"]["choices"]] == ["Ada", "bob", "Cleo", "Dan"]
    # Yes/no as text reads Yes and No.
    ok(patch(c, f"/api/tables/{db}/fields/{f['member']}", {"type": "text"}))
    assert names(view(c, db, table), f["member"]) == ["Yes", "No", "Yes", None]


def test_rename_reorder_and_delete_fields(people):
    c, db, table, f = people
    ok(patch(c, f"/api/tables/{db}/fields/{f['age']}", {"name": "Years", "width": 40}))
    # Names are unique in a table, ignoring case, and ID is taken.
    ok(patch(c, f"/api/tables/{db}/fields/{f['joined']}", {"name": "years"}))
    ok(patch(c, f"/api/tables/{db}/fields/{f['member']}", {"name": "id"}))
    fields = schema(c, db)["tables"][0]["fields"]
    assert [x["name"] for x in fields] == ["Name", "Notes", "Years", "years 2", "id 2"]
    assert fields[2]["width"] == 60
    order = [f["member"], f["name"]]
    s = ok(patch(c, f"/api/tables/{db}/tables/{table}", {"field_order": order}))
    assert [x["id"] for x in s["tables"][0]["fields"]][:2] == order
    ok(delete(c, f"/api/tables/{db}/fields/{f['age']}"))
    assert str(f["age"]) not in view(c, db, table)["rows"][0]["values"]
    # A query that used it says so.
    response = run_query(c, db, {"table_id": table, "fields": [{"field": f["age"]}]})
    assert response.status_code == 422


def test_link_fields_name_the_linked_row(people):
    c, db, people_table, f = people
    s = ok(c.post_json(f"/api/tables/{db}/tables", {"name": "Teams"}))
    teams = s["table_id"]
    team_name = next(t for t in s["tables"] if t["id"] == teams)["fields"][0]["id"]
    made = add_rows(c, db, teams, [{str(team_name): "Red"}, {str(team_name): "Blue"}])
    red, blue = (r["id"] for r in made["rows"])
    team = add_field(c, db, people_table, "Team", "link", {"table_id": teams})
    rows = view(c, db, people_table)["rows"]
    # By id when picked, or by name when typed or pasted.
    ok(
        patch(
            c,
            f"/api/tables/{db}/tables/{people_table}/rows",
            {
                "updates": [
                    {"id": rows[0]["id"], "values": {str(team): red}},
                    {"id": rows[1]["id"], "values": {str(team): "blue"}},
                    {"id": rows[2]["id"], "values": {str(team): "#1"}},
                ]
            },
        )
    )
    result = view(c, db, people_table)
    assert [r["labels"].get(str(team)) for r in result["rows"]] == ["Red", "Blue", "Red", None]
    assert names(result, team) == [red, blue, red, None]
    bad = patch(
        c,
        f"/api/tables/{db}/tables/{people_table}/rows",
        {"updates": [{"id": rows[0]["id"], "values": {str(team): "Green"}}]},
    )
    assert bad.status_code == 422
    # Filters and sorting go by the linked row's name.
    sorted_ = view(c, db, people_table, sort=[{"field": team, "dir": "asc"}])
    assert [r["labels"].get(str(team)) for r in sorted_["rows"]] == ["Blue", "Red", "Red", None]
    filtered = view(c, db, people_table, filters=[{"field": team, "op": "=", "value": "red"}])
    assert filtered["total"] == 2
    # Picking a row to link to.
    found = ok(c.post_json(f"/api/tables/{db}/tables/{teams}/lookup", {"search": "bl"}))
    assert [r["label"] for r in found["rows"]] == ["Blue"]
    every = ok(c.post_json(f"/api/tables/{db}/tables/{teams}/lookup", {}))
    assert [r["label"] for r in every["rows"]] == ["Blue", "Red"]
    # A linked table can't be deleted while something links to it.
    response = delete(c, f"/api/tables/{db}/tables/{teams}")
    assert response.status_code == 409
    assert response.json()["detail"].startswith("Table 1.Team links to this table.")
    # Deleting a linked row empties the links to it.
    ok(c.post_json(f"/api/tables/{db}/tables/{teams}/rows/delete", {"ids": [red]}))
    assert names(view(c, db, people_table), team) == [None, blue, None, None]


def test_pasting_adds_new_choices(people):
    c, db, table, _ = people
    status = add_field(
        c, db, table, "Status", "choice", {"choices": [{"name": "Open", "color": "green"}]}
    )
    rows = view(c, db, table)["rows"]
    updates = [
        {"id": rows[0]["id"], "values": {str(status): "open"}},
        {"id": rows[1]["id"], "values": {str(status): "Closed"}},
    ]
    url = f"/api/tables/{db}/tables/{table}/rows"
    assert patch(c, url, {"updates": updates}).status_code == 422
    ok(patch(c, url, {"updates": updates, "add_choices": True}))
    field = next(x for x in schema(c, db)["tables"][0]["fields"] if x["id"] == status)
    assert [ch["name"] for ch in field["options"]["choices"]] == ["Open", "Closed"]
    assert names(view(c, db, table), status)[:2] == ["Open", "Closed"]


def test_tables_rename_and_delete(people):
    c, db, table, _ = people
    s = ok(c.post_json(f"/api/tables/{db}/tables", {"name": "table 1"}))
    assert [t["name"] for t in s["tables"]] == ["Table 1", "table 1 2"]
    other = s["table_id"]
    ok(c.post_json(f"/api/tables/{db}/objects", {"kind": "form", "spec": {"table_id": other}}))
    ok(patch(c, f"/api/tables/{db}/tables/{other}", {"name": "Orders", "position": 0}))
    assert [t["name"] for t in schema(c, db)["tables"]] == ["Orders", "Table 1"]
    s = ok(delete(c, f"/api/tables/{db}/tables/{other}"))
    assert [t["name"] for t in s["tables"]] == ["Table 1"]
    assert s["forms"] == []


# ---------------------------------------------------------------- sharing


def test_share_links_decide_who_can_change_a_database(people, app_factory):
    c, db, table, f = people
    view_link = ok(c.post_json(f"/api/files/{db}/shares", {"role": "view"}))["link"]
    edit_link = ok(c.post_json(f"/api/files/{db}/shares", {"role": "edit"}))["link"]
    with Client(c.app) as anon:
        anon.refresh()
        seen = {"X-Share-Token": view_link["token"]}
        opened = ok(anon.get(f"/api/tables/{db}", headers=seen))
        assert opened["role"] == "view" and opened["database"]["owner"] == "kev"
        rows = ok(
            anon.post(
                f"/api/tables/{db}/tables/{table}/rows/query",
                json={},
                headers={**seen, "X-CSRF-Token": anon.csrf},
            )
        )
        assert rows["total"] == 4
        body = {"updates": [{"id": rows["rows"][0]["id"], "values": {str(f["name"]): "x"}}]}
        url = f"/api/tables/{db}/tables/{table}/rows"
        assert patch(anon, url, body, **seen).status_code == 403
        assert delete(anon, f"/api/tables/{db}/fields/{f['age']}", **seen).status_code == 403
        editor = {"X-Share-Token": edit_link["token"]}
        assert patch(anon, url, body, **editor).status_code == 200
        # Rename, move, delete and sharing stay with the owner.
        assert delete(anon, f"/api/files/{db}", **editor).status_code in {401, 403}


def test_shared_databases_are_listed(people, app_factory):
    c, db, _, _ = people
    with Client(c.app) as sam:
        assert sam.register("sam").status_code == 200
        ok(c.post_json(f"/api/files/{db}/members", {"username": "sam", "role": "edit"}))
        listed = ok(sam.get("/api/tables/databases"))
        assert listed["databases"] == []
        assert [(s["id"], s["role"]) for s in listed["shared"]] == [(db, "edit")]


# ------------------------------------------------------ import and export


def test_csv_export_follows_the_datasheet(people):
    c, db, table, f = people
    view_json = json.dumps({"sort": [{"field": f["age"], "dir": "desc"}]})
    response = c.get(f"/api/tables/{db}/export.csv", params={"table": table, "view": view_json})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    lines = list(csv.reader(io.StringIO(response.text.lstrip("﻿"))))
    assert lines[0] == ["ID", "Name", "Notes", "Age", "Joined", "Member"]
    assert lines[1] == ["3", "Cleo", "", "41.5", "", "Yes"]
    assert lines[4] == ["4", "Dan", "", "", "", ""]
    spec = {"table_id": table, "totals": True, "fields": [{"field": "id", "total": "count"}]}
    saved = ok(
        c.post_json(f"/api/tables/{db}/objects", {"kind": "query", "name": "Count", "spec": spec})
    )
    response = c.get(f"/api/tables/{db}/export.csv", params={"query": saved["object_id"]})
    assert response.text.lstrip("﻿").splitlines() == ["CountOfID", "4"]


def test_import_makes_a_table_with_guessed_types(user_client):
    c = user_client
    db = ok(c.post_json("/api/tables/databases", {"name": "Imports", "starter": False}))["database"]
    assert schema(c, db["id"])["tables"] == []
    result = ok(
        c.post_json(
            f"/api/tables/{db['id']}/import",
            {
                "name": "Orders",
                "columns": [{"name": "Item"}, {"name": "Qty"}, {"name": "Due"}, {"name": "Paid"}],
                "rows": [["Pens", "3", "2026-01-02", "yes"], ["Ink", "10", "", "no"], ["Pad"]],
            },
        )
    )
    table = result["tables"][0]
    assert table["name"] == "Orders" and table["row_count"] == 3
    assert [x["type"] for x in table["fields"]] == ["text", "number", "date", "checkbox"]
    rows = view(c, db["id"], result["table_id"])["rows"]
    assert rows[1]["values"][str(table["fields"][1]["id"])] == 10


def test_export_and_restore_a_whole_database(people):
    c, db, table, f = people
    teams = ok(c.post_json(f"/api/tables/{db}/tables", {"name": "Teams"}))["table_id"]
    team_field = schema(c, db)["tables"][1]["fields"][0]["id"]
    red = add_rows(c, db, teams, [{str(team_field): "Red"}])["rows"][0]["id"]
    link = add_field(c, db, table, "Team", "link", {"table_id": teams})
    first = view(c, db, table)["rows"][0]["id"]
    ok(
        patch(
            c,
            f"/api/tables/{db}/tables/{table}/rows",
            {"updates": [{"id": first, "values": {str(link): red}}]},
        )
    )
    spec = {"table_id": table, "fields": [{"field": f["name"], "sort": "asc"}, {"field": link}]}
    ok(c.post_json(f"/api/tables/{db}/objects", {"kind": "query", "name": "Q", "spec": spec}))

    exported = c.get(f"/api/tables/{db}/export.json")
    assert exported.status_code == 200
    dump = exported.json()
    assert dump["format"] == "markdown-studio.tables"

    # Uploading the file restores it as a new database.
    response = c.post(
        "/api/files/upload",
        params={"name": "Copy.tables"},
        content=exported.content,
        headers={"X-CSRF-Token": c.csrf},
    )
    copy_id = ok(response)["file"]["id"]
    copy = schema(c, copy_id)
    assert [t["name"] for t in copy["tables"]] == ["Table 1", "Teams"]
    new_table = copy["tables"][0]
    new_link = next(x for x in new_table["fields"] if x["type"] == "link")
    assert new_link["options"]["table_id"] == copy["tables"][1]["id"]
    rows = view(c, copy_id, new_table["id"])["rows"]
    assert rows[0]["labels"] == {str(new_link["id"]): "Red"}
    assert [r["number"] for r in rows] == [1, 2, 3, 4]
    saved = copy["queries"][0]
    result = ok(run_query(c, copy_id, saved["spec"]))
    assert [col["name"] for col in result["columns"]] == ["Name", "Team"]
    # New rows carry on numbering after the restored ones.
    assert add_rows(c, copy_id, new_table["id"], [{}])["rows"][0]["number"] == 5


def test_revision_moves_with_every_change(people):
    c, db, table, _ = people
    before = ok(c.get(f"/api/tables/{db}/revision"))["revision"]
    add_rows(c, db, table, [{}])
    assert ok(c.get(f"/api/tables/{db}/revision"))["revision"] == before + 1


# ---------------------------------------------------------- the compiler


def test_criteria_rows_with_different_where_conditions_cant_split():
    fields = {1: q.Field(1, "A", "number", {}), 2: q.Field(2, "B", "number", {})}
    design = q.design_from_spec(
        {
            "totals": True,
            "or_rows": 1,
            "fields": [
                {"field": 1, "total": "where", "criteria": {"op": ">", "value": "1"}},
                {"field": 2, "total": "sum", "or": [{"op": ">", "value": "2"}]},
            ],
        }
    )
    with pytest.raises(q.QueryError, match="different Where conditions"):
        q.compile_design(1, design, fields)
