from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from conftest import Client

from studio.wordnet import WordNet, base_forms

LICENCE = (
    "  1 This software and database is being provided to you\n  2 under the WordNet licence.\n"
)

# word -> [(gloss, [synonyms])] for each part of speech; a tiny WordNet.
TINY = {
    "noun": {
        "colour": [
            ('a visual attribute of things; "the colour of the sky"', ["color", "coloring"])
        ],
        "dog": [
            ('a domesticated canid; "the dog barked all night"', ["domestic_dog"]),
            ("a dull unattractive unpleasant girl or woman", ["frump"]),
        ],
        "ice_cream": [("frozen dessert containing cream and sugar", ["icecream"])],
    },
    "verb": {
        "dog": [("go after with the intent to catch", ["chase", "trail"])],
        "run": [("move fast by using one's feet; \"Don't run!\"", ["go"])],
    },
    "adj": {"happy": [("enjoying well-being and contentment", ["felicitous(a)"])]},
    "adv": {},
}


def write_wordnet(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for pos, words in TINY.items():
        data = LICENCE.encode()
        index_lines = []
        for lemma in sorted(words):
            offsets = []
            for gloss, synonyms in words[lemma]:
                offset = len(data)
                members = [lemma, *synonyms]
                head = f"{offset:08d} 03 n {len(members):02x} " + " ".join(
                    f"{m} 0" for m in members
                )
                data += f"{head} 000 | {gloss}  \n".encode()
                offsets.append(offset)
            joined = " ".join(f"{o:08d}" for o in offsets)
            index_lines.append(f"{lemma} n {len(offsets)} 1 @ {len(offsets)} 0 {joined}  \n")
        (directory / f"data.{pos}").write_bytes(data)
        (directory / f"index.{pos}").write_text(LICENCE + "".join(index_lines))
    return directory


@pytest.fixture
def wordnet(tmp_path) -> WordNet:
    found = WordNet.open(write_wordnet(tmp_path / "wordnet"))
    assert found is not None
    return found


def test_defines_a_word_with_every_part_of_speech(wordnet):
    entry = wordnet.define("Dog")
    assert entry["word"] == "Dog" and entry["lemma"] == "dog"
    assert [e["pos"] for e in entry["entries"]] == ["noun", "verb"]
    first = entry["entries"][0]["senses"][0]
    assert first == {
        "definition": "a domesticated canid",
        "examples": ["the dog barked all night"],
        "synonyms": ["domestic dog"],
    }
    assert len(entry["entries"][0]["senses"]) == 2


def test_finds_base_forms_and_phrases(wordnet):
    assert wordnet.define("running")["entries"][0] | {"senses": []} == {
        "pos": "verb",
        "lemma": "run",
        "senses": [],
    }
    assert wordnet.define("happiest")["lemma"] == "happy"
    assert wordnet.define("happier")["entries"][0]["senses"][0]["synonyms"] == ["felicitous"]
    assert wordnet.define("ice cream")["lemma"] == "ice cream"
    assert wordnet.define("colour’s") is None
    assert wordnet.define("zebra") is None
    assert wordnet.define("") is None


def test_base_forms():
    assert base_forms("boxes", "noun") == ["boxes", "boxe", "box"]
    assert "stop" in base_forms("stopped", "verb")
    assert base_forms("fast", "adv") == ["fast"]


def test_missing_wordnet_turns_lookup_off(tmp_path):
    assert WordNet.open(None) is None
    assert WordNet.open(tmp_path) is None


# ---------------------------------------------------------------- the API


def make_client(app_factory, tmp_path, transport=None, **env):
    app = app_factory(WORDNET_DIR=str(write_wordnet(tmp_path / "wn")), **env)
    if transport is not None:
        app.state.language.transport = transport
    return Client(app)


def test_features_follow_the_configuration(app_factory, tmp_path):
    with make_client(app_factory, tmp_path) as client:
        assert client.get("/api/language").json() == {
            "lookup": True,
            "grammar": False,
            "translate": False,
        }
        client.register()
        assert (
            client.post_json("/api/language/check", {"annotation": [{"text": "Hi"}]}).status_code
            == 503
        )
        assert (
            client.post_json("/api/language/translate", {"text": "Hi", "target": "fr"}).status_code
            == 503
        )

    env = {"LANGUAGETOOL_URL": "http://lt:8010/", "LIBRETRANSLATE_URL": "http://lt2:5000"}
    with make_client(app_factory, tmp_path, **env) as client:
        assert client.get("/api/language").json() == {
            "lookup": True,
            "grammar": True,
            "translate": True,
        }


def test_define_needs_no_account(app_factory, tmp_path):
    with make_client(app_factory, tmp_path) as client:
        response = client.get("/api/language/define", params={"word": "dogs"})
        assert response.status_code == 200 and response.json()["lemma"] == "dog"
        assert client.get("/api/language/define", params={"word": "zzz"}).status_code == 404


def test_define_without_wordnet(app_factory, tmp_path):
    with Client(app_factory(WORDNET_DIR=str(tmp_path / "nowhere"))) as client:
        assert client.get("/api/language").json()["lookup"] is False
        assert client.get("/api/language/define", params={"word": "dog"}).status_code == 503


def languagetool(request: httpx.Request) -> httpx.Response:
    assert request.url == "http://lt:8010/v2/check"
    form = dict(httpx.QueryParams(request.content.decode()))
    assert form["language"] == "en-GB" and form["disabledCategories"] == "TYPOS,STYLE"
    assert json.loads(form["data"]) == {
        "annotation": [{"markup": "**"}, {"text": "This are good."}]
    }
    match = {"offset": 7, "length": 3, "message": "Use 'is'.", "shortMessage": "Grammar"}
    return httpx.Response(
        200,
        json={
            "matches": [
                {
                    **match,
                    "replacements": [{"value": "is"}],
                    "rule": {"id": "AGREEMENT", "issueType": "grammar"},
                },
                {
                    **match,
                    "replacements": [],
                    "rule": {"id": "MORFOLOGIK", "issueType": "misspelling"},
                },
            ]
        },
    )


def test_grammar_goes_through_languagetool(app_factory, tmp_path):
    transport = httpx.MockTransport(languagetool)
    with make_client(app_factory, tmp_path, transport, LANGUAGETOOL_URL="http://lt:8010") as client:
        body = {"language": "en-GB", "annotation": [{"markup": "**"}, {"text": "This are good."}]}
        client.refresh()
        assert client.post_json("/api/language/check", body).status_code == 401
        client.register()
        response = client.post_json("/api/language/check", body)
        assert response.status_code == 200, response.text
        assert response.json() == {
            "matches": [
                {
                    "offset": 7,
                    "length": 3,
                    "message": "Use 'is'.",
                    "short": "Grammar",
                    "replacements": ["is"],
                    "rule": "AGREEMENT",
                }
            ]
        }
        assert (
            client.post_json("/api/language/check", {**body, "language": "fr"}).status_code == 400
        )
        huge = {"annotation": [{"text": "a" * 20_001}]}
        assert client.post_json("/api/language/check", huge).status_code == 400


def test_grammar_server_down(app_factory, tmp_path):
    def down(request):
        raise httpx.ConnectError("refused")

    transport = httpx.MockTransport(down)
    with make_client(app_factory, tmp_path, transport, LANGUAGETOOL_URL="http://lt:8010") as client:
        client.register()
        response = client.post_json("/api/language/check", {"annotation": [{"text": "Hi"}]})
        assert response.status_code == 502


def libretranslate(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/languages":
        return httpx.Response(200, json=[{"code": "fr", "name": "French", "targets": ["en"]}])
    body = json.loads(request.content)
    assert body == {
        "q": "Hello",
        "source": "auto",
        "target": "fr",
        "format": "text",
        "api_key": "k",
    }
    return httpx.Response(
        200, json={"translatedText": "Bonjour", "detectedLanguage": {"language": "en"}}
    )


def test_translate_goes_through_libretranslate(app_factory, tmp_path):
    transport = httpx.MockTransport(libretranslate)
    env = {"LIBRETRANSLATE_URL": "http://lt:5000", "LIBRETRANSLATE_API_KEY": "k"}
    with make_client(app_factory, tmp_path, transport, **env) as client:
        assert client.get("/api/language/translate/languages").status_code == 401
        client.refresh()
        assert (
            client.post_json("/api/language/translate", {"text": "Hi", "target": "fr"}).status_code
            == 401
        )
        client.register()
        assert client.get("/api/language/translate/languages").json() == {
            "languages": [{"code": "fr", "name": "French"}]
        }
        response = client.post_json("/api/language/translate", {"text": "Hello", "target": "fr"})
        assert response.json() == {"text": "Bonjour", "detected": "en"}
        too_long = {"text": "a" * 5001, "target": "fr"}
        assert client.post_json("/api/language/translate", too_long).status_code == 400


def test_language_urls_are_checked(app_factory):
    from studio.config import ConfigError

    with pytest.raises(ConfigError):
        app_factory(LANGUAGETOOL_URL="lt:8010")
