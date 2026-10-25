from __future__ import annotations

from conftest import Client

from studio.powertools import PowerTools, parse_apps


def entry(app_id: str, url: str, **extra) -> dict:
    return {"id": app_id, "name": app_id.title(), "url": url, **extra}


def test_external_sites_are_allowed_and_marked():
    apps = parse_apps(
        {
            "apps": [
                entry("puddle", "https://puddle.kevspowertools.com/"),
                entry("noodleplanner", "https://www.noodleplanner.com/"),
                entry("filmcolab", "https://filmcolab.com/"),
            ]
        }
    )
    assert [(a.id, a.external) for a in apps] == [
        ("puddle", False),
        ("noodleplanner", True),
        ("filmcolab", True),
    ]


def test_other_hosts_and_plain_http_are_dropped():
    apps = parse_apps(
        {
            "apps": [
                entry("evil", "https://example.com/"),
                entry("lookalike", "https://notnoodleplanner.com/"),
                entry("http", "http://www.filmcolab.com/"),
            ]
        }
    )
    assert apps == []


def test_hidden_ids_are_left_out_of_fetched_and_bundled_lists():
    fetched = {
        "apps": [
            entry("puddle", "https://puddle.kevspowertools.com/"),
            entry("filmcolab", "https://www.filmcolab.com/"),
        ]
    }
    tools = PowerTools("https://x", fetch=lambda _: fetched, hide={"filmcolab"})
    assert [a.id for a in tools.apps()] == ["puddle"]
    bundled = PowerTools("", hide={"noodleplanner", "filmcolab"}).apps()
    assert bundled and not {"noodleplanner", "filmcolab"} & {a.id for a in bundled}


def test_bundled_list_includes_noodleplanner_and_filmcolab(client):
    apps = {a["id"]: a for a in client.get("/api/powertools").json()["apps"]}
    assert apps["noodleplanner"]["external"] is True
    assert apps["filmcolab"]["external"] is True
    assert apps["mermaid-factory"]["external"] is False


def test_powertools_hide_setting(app_factory):
    with Client(app_factory(POWERTOOLS_HIDE="noodleplanner, filmcolab")) as c:
        ids = {a["id"] for a in c.get("/api/powertools").json()["apps"]}
    assert "mermaid-factory" in ids
    assert not {"noodleplanner", "filmcolab"} & ids
