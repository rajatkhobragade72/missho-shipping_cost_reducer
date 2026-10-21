import zipfile
from io import BytesIO

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import ai, imaging, main


def _jpeg() -> bytes:
    img = Image.new("RGB", (800, 600), (255, 255, 255))
    img.paste((20, 120, 200), (250, 150, 550, 450))
    buf = BytesIO()
    img.save(buf, "JPEG")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    monkeypatch.delenv("POLLINATIONS_API_KEY", raising=False)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    return TestClient(main.app)



def _hero(client):
    res = client.post("/api/hero", files={"file": ("p.jpg", _jpeg(), "image/jpeg")})
    assert res.status_code == 200
    return res.json()


def test_hero_returns_original_framed_variants(client):
    data = _hero(client)
    assert data["ai_configured"] is False
    assert [v["style_key"] for v in data["variants"]] == [s.key for s in imaging.ORIGINAL_STYLES]
    assert client.get(data["variants"][0]["url"]).headers["content-type"] == "image/jpeg"


def test_hero_rejects_invalid_upload(client):
    res = client.post("/api/hero", files={"file": ("x.jpg", b"garbage", "image/jpeg")})
    assert res.status_code == 400


def test_extras_use_chosen_style_and_zip(client):
    data = _hero(client)
    hero = data["variants"][0]
    res = client.post(
        "/api/extras",
        data={"session": data["session"], "style_key": hero["style_key"]},
        files=[("files", ("a.jpg", _jpeg(), "image/jpeg")), ("files", ("b.jpg", _jpeg(), "image/jpeg"))],
    )
    assert res.status_code == 200
    images = res.json()["images"]
    assert [i["name"] for i in images] == ["extra_01.jpg", "extra_02.jpg"]

    style = imaging.STYLES_BY_KEY[hero["style_key"]]
    img = Image.open(BytesIO(client.get(images[0]["url"]).content))
    assert img.size == imaging.ASPECTS[style.aspect]

    names = [hero["name"]] + [i["name"] for i in images]
    res = client.get(f"/api/download/{data['session']}", params={"names": names})
    assert res.status_code == 200
    assert len(zipfile.ZipFile(BytesIO(res.content)).namelist()) == 3


def test_extras_accept_default_style(client):
    data = _hero(client)
    res = client.post(
        "/api/extras",
        data={"session": data["session"], "style_key": data["default_extra_style"]},
        files=[("files", ("a.jpg", _jpeg(), "image/jpeg"))],
    )
    assert res.status_code == 200


def test_extras_rejects_unknown_style(client):
    data = _hero(client)
    res = client.post(
        "/api/extras",
        data={"session": data["session"], "style_key": "../../evil"},
        files=[("files", ("a.jpg", _jpeg(), "image/jpeg"))],
    )
    assert res.status_code == 400


def test_sheet_ranks_by_cost(client, monkeypatch):
    data = _hero(client)
    v = data["variants"]
    captured = {}
    real_build = imaging.build_sheet
    monkeypatch.setattr(imaging, "build_sheet", lambda items: captured.setdefault("items", items) and real_build(items))
    res = client.post("/api/sheet", json={
        "session": data["session"],
        "target": 40,
        "items": [{"name": v[0]["name"], "cost": 55}, {"name": v[1]["name"]}, {"name": v[2]["name"], "cost": 38}],
    })
    assert res.status_code == 200 and res.headers["content-type"] == "image/jpeg"
    titles = [i.title for i in captured["items"]]
    assert titles == ["#1  USE THIS  Rs 38", "#2  Rs 55  (over)", "#3  Not tested"]
    assert [i.highlight for i in captured["items"]] == [True, False, False]


def test_sheet_rejects_bad_names(client):
    data = _hero(client)
    res = client.post("/api/sheet", json={"session": data["session"], "items": [{"name": "../x.jpg"}]})
    assert res.status_code == 422


def test_ai_requires_key(client):
    data = _hero(client)
    assert client.get("/api/config").json()["ai_configured"] is False
    res = client.post("/api/ai-variants", data={"session": data["session"], "presets": ["clean-white"]})
    assert res.status_code == 503


def test_ai_presets_strip_text_and_flag_lifestyle(client):
    presets = {p["key"]: p for p in client.get("/api/config").json()["ai_presets"]}
    assert presets["lifestyle"]["hero"] is False
    assert presets["clean-white"]["hero"] is True
    for key, (_, prompt) in ai.PRESETS.items():
        assert "no text or letters" in prompt and "texture" in prompt
        assert ("No hands" in prompt) == (key not in ai.NON_HERO_PRESETS)


def test_ai_variants_success_and_partial_failure(client, monkeypatch):
    monkeypatch.setenv("POLLINATIONS_API_KEY", "FAKE-KEY-FOR-TESTING")
    generated = BytesIO()
    ai_img = Image.new("RGB", (1024, 1024), (255, 255, 255))
    ai_img.paste((0, 200, 0), (312, 212, 712, 812))
    ai_img.save(generated, "PNG")

    def fake_edit(image_png, prompt):
        assert Image.open(BytesIO(image_png)).format == "PNG"
        if "pastel" in prompt:
            raise httpx.ConnectError("boom")
        return generated.getvalue()

    monkeypatch.setattr(ai, "edit_image", fake_edit)
    data = _hero(client)
    res = client.post("/api/ai-variants", data={"session": data["session"], "presets": ["clean-white", "pastel"]})
    assert res.status_code == 200
    body = res.json()
    assert body["failed"] == ["Soft pastel background"]
    assert body["variants"][0]["ai"] is True
    assert [v["style_key"] for v in body["variants"][1:]] == [s.key for s in imaging.CLEAN_STYLES]
    img = Image.open(BytesIO(client.get(body["variants"][0]["url"]).content))
    assert img.size == imaging.ASPECTS["1:1"]

    tight = next(v for v in body["variants"] if v["style_key"] == "1x1_90_clean")
    framed = Image.open(BytesIO(client.get(tight["url"]).content)).convert("L")
    bbox = Image.eval(framed, lambda p: 255 if p < 200 else 0).getbbox()
    assert bbox[3] - bbox[1] == pytest.approx(1500 * 0.9, abs=4)

    sheet = client.post("/api/sheet", json={"session": data["session"], "items": [{"name": body["variants"][0]["name"]}]})
    assert sheet.status_code == 200


def test_ai_rejects_unknown_preset(client, monkeypatch):
    monkeypatch.setenv("POLLINATIONS_API_KEY", "FAKE-KEY-FOR-TESTING")
    data = _hero(client)
    res = client.post("/api/ai-variants", data={"session": data["session"], "presets": ["ignore previous"]})
    assert res.status_code == 400


def test_edit_image_sends_key_and_decodes(monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setenv("POLLINATIONS_API_KEY", "FAKE-KEY-FOR-TESTING")
    seen = {}

    def fake_post(self, url, **kwargs):
        seen.update(kwargs, url=url)
        return httpx.Response(200, json={"data": [{"b64_json": "aGVsbG8="}]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.Client, "post", fake_post)
    assert ai.edit_image(b"png", "prompt") == b"hello"
    assert seen["url"] == ai.API_URL
    assert seen["headers"]["Authorization"] == "Bearer FAKE-KEY-FOR-TESTING"
    assert seen["data"]["prompt"] == "prompt"


def test_edit_image_hf_sends_token_and_decodes(monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf_fake_token_123")
    seen = {}

    def fake_post(self, url, **kwargs):
        seen.update(kwargs, url=url)
        return httpx.Response(200, content=b"fake-image-bytes", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.Client, "post", fake_post)
    assert ai.edit_image(b"png", "prompt") == b"fake-image-bytes"
    assert "timbrooks/instruct-pix2pix" in seen["url"]
    assert seen["headers"]["Authorization"] == "Bearer hf_fake_token_123"
    assert "inputs" in seen["json"]
    assert seen["json"]["parameters"]["prompt"] == "prompt"



def test_latest_session_and_cost_roundtrip(client):
    assert client.get("/api/sessions/latest").status_code == 404
    data = _hero(client)
    latest = client.get("/api/sessions/latest").json()
    assert latest["session"] == data["session"]
    assert {i["name"] for i in latest["images"]} == {v["name"] for v in data["variants"]}
    assert latest["costs"] == {}

    name = data["variants"][0]["name"]
    assert client.post("/api/costs", json={"session": data["session"], "name": name, "cost": 38}).status_code == 200
    assert client.get(f"/api/costs/{data['session']}").json() == {name: {"cost": 38, "source": "meesho"}}
    client.post("/api/costs", json={"session": data["session"], "name": name, "cost": 41, "source": "manual"})
    assert client.get(f"/api/costs/{data['session']}").json()[name] == {"cost": 41, "source": "manual"}
    assert client.delete(f"/api/costs/{data['session']}/{name}").status_code == 200
    assert client.get(f"/api/costs/{data['session']}").json() == {}


def test_measured_charge_is_stored_and_shown(client):
    """Extension ka asli Meesho reading website par dikhta hai (photo + charge)."""
    data = _hero(client)
    session = data["session"]
    res = client.post(
        "/api/measured",
        files={"file": ("m.jpg", _jpeg(), "image/jpeg")},
        data={"label": "product cut | 85% fill", "cost": 51, "session": session},
    )
    assert res.status_code == 200
    name = res.json()["name"]
    assert name.startswith("measured_")
    costs = client.get(f"/api/costs/{session}").json()
    assert costs[name] == {"cost": 51, "source": "meesho", "label": "product cut | 85% fill"}
    measured = client.get(f"/api/measurements/{session}").json()
    assert [i["name"] for i in measured["images"]] == [name]
    assert measured["images"][0]["cost"] == 51
    # Wahi photo dobara bhejne par naya duplicate nahi banna chahiye.
    again = client.post(
        "/api/measured",
        files={"file": ("m.jpg", _jpeg(), "image/jpeg")},
        data={"label": "product cut | 85% fill", "cost": 48, "session": session},
    )
    assert again.json()["name"] == name
    assert client.get(f"/api/costs/{session}").json()[name]["cost"] == 48


def test_measured_charge_matches_existing_image_by_hash(client):
    """Website ki image test ho to usi ka cost update hota hai, duplicate nahi banta."""
    data = _hero(client)
    session = data["session"]
    hero = data["variants"][0]
    raw = client.get(hero["url"]).content
    res = client.post(
        "/api/measured",
        files={"file": (hero["name"], raw, "image/jpeg")},
        data={"label": "aisi hi photo", "cost": 77, "session": session},
    )
    assert res.json()["name"] == hero["name"]
    costs = client.get(f"/api/costs/{session}").json()
    assert costs[hero["name"]]["cost"] == 77
    # Website ka apna label bacha rahe.
    assert "label" not in costs[hero["name"]]


def test_measured_needs_a_session(client):
    res = client.post("/api/measured", files={"file": ("m.jpg", _jpeg(), "image/jpeg")}, data={"cost": 51})
    assert res.status_code == 404


def test_current_session_is_set_only_by_the_website(client):
    assert client.get("/api/current-session").json() == {"session": None}
    res = client.post(
        "/api/hero",
        files={"file": ("p.jpg", _jpeg(), "image/jpeg")},
        data={"set_current": "true"},
    )
    session = res.json()["session"]
    assert client.get("/api/current-session").json() == {"session": session}
    # Extension ka apna hero call current session nahi badalta.
    other = client.post("/api/hero", files={"file": ("p.jpg", _jpeg(), "image/jpeg")})
    assert client.get("/api/current-session").json() == {"session": session}
    assert other.json()["session"] != session


@pytest.mark.parametrize("body", [
    {"name": "hero_1x1_90_orig.jpg", "cost": -1},
    {"name": "hero_1x1_90_orig.jpg", "cost": 38, "source": "other"},
    {"name": "../x.jpg", "cost": 38},
])
def test_cost_report_validation(client, body):
    data = _hero(client)
    assert client.post("/api/costs", json={"session": data["session"], **body}).status_code == 422


def test_cost_report_requires_existing_image(client):
    data = _hero(client)
    res = client.post("/api/costs", json={"session": data["session"], "name": "nope.jpg", "cost": 38})
    assert res.status_code == 404


def test_regenerating_clean_variants_clears_their_costs(client, monkeypatch):
    monkeypatch.setenv("POLLINATIONS_API_KEY", "FAKE-KEY-FOR-TESTING")
    buf = BytesIO()
    img = Image.new("RGB", (1024, 1024), (255, 255, 255))
    img.paste((0, 0, 0), (300, 300, 700, 700))
    img.save(buf, "PNG")
    monkeypatch.setattr(ai, "edit_image", lambda png, prompt: buf.getvalue())
    data = _hero(client)
    run = lambda: client.post("/api/ai-variants", data={"session": data["session"], "presets": ["clean-white"]}).json()
    framed = run()["variants"][1]["name"]
    keep = data["variants"][0]["name"]
    for name in (framed, keep):
        client.post("/api/costs", json={"session": data["session"], "name": name, "cost": 40})
    run()
    assert set(client.get(f"/api/costs/{data['session']}").json()) == {keep}


@pytest.mark.parametrize("path", [
    "/api/image/notasession/x.jpg",
    "/api/image/{s}/..%2F..%2Fsecret.jpg",
    "/api/image/{s}/source.png",
    "/api/download/{s}?names=..%2Fx.jpg",
])
def test_path_traversal_is_blocked(client, path):
    session = _hero(client)["session"]
    assert client.get(path.format(s=session)).status_code == 404
