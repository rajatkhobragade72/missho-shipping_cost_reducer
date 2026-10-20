import io
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Annotated, Literal

import httpx
import truststore
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import ai, imaging

truststore.inject_into_ssl()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("SHIPOPT_DATA_DIR", BASE_DIR.parent / "data" / "sessions"))
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_EXTRA_FILES = 10
SESSION_TTL_SECONDS = 24 * 3600
SESSION_RE = re.compile(r"^[0-9a-f]{32}$")
NAME_PATTERN = r"^[A-Za-z0-9_\-]{1,80}\.jpg$"
NAME_RE = re.compile(NAME_PATTERN)
AI_SOURCE_NAME = "source.png"
COSTS_NAME = "costs.json"
TESTABLE_PREFIXES = ("hero_", "ai_")
_costs_lock = threading.Lock()

logger = logging.getLogger(__name__)


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(BASE_DIR.parent / ".env")

app = FastAPI(title="Meesho Shipping Optimizer")


def _read_upload(file: UploadFile) -> imaging.Image.Image:
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image larger than 15 MB")
    try:
        return imaging.load_image(data)
    except imaging.InvalidImageError as exc:
        raise HTTPException(400, str(exc)) from exc


def _session_dir(session: str) -> Path:
    if not SESSION_RE.fullmatch(session):
        raise HTTPException(404, "Session not found")
    path = DATA_DIR / session
    if not path.is_dir():
        raise HTTPException(404, "Session not found")
    return path


def _session_file(session_dir: Path, name: str) -> Path:
    if not NAME_RE.fullmatch(name) or not (session_dir / name).is_file():
        raise HTTPException(404, "Image not found")
    return session_dir / name


def _cleanup_old_sessions() -> None:
    if not DATA_DIR.is_dir():
        return
    cutoff = time.time() - SESSION_TTL_SECONDS
    for path in DATA_DIR.iterdir():
        if path.is_dir() and SESSION_RE.fullmatch(path.name) and path.stat().st_mtime < cutoff:
            shutil.rmtree(path, ignore_errors=True)


def _save(session_dir: Path, name: str, img: imaging.Image.Image) -> str:
    (session_dir / name).write_bytes(imaging.encode_jpeg(img))
    return f"/api/image/{session_dir.name}/{name}"


def _read_costs(session_dir: Path) -> dict[str, dict]:
    path = session_dir / COSTS_NAME
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _update_costs(session_dir: Path, updates: dict[str, dict] | None = None, remove: tuple[str, ...] = ()) -> None:
    with _costs_lock:
        costs = _read_costs(session_dir)
        for name in remove:
            costs.pop(name, None)
        costs.update(updates or {})
        (session_dir / COSTS_NAME).write_text(json.dumps(costs), encoding="utf-8")


def _short_label(name: str) -> str:
    if name.startswith("hero_") and (style := imaging.STYLES_BY_KEY.get(name[5:-4])):
        return style.short_label
    if name.startswith("ai_") and (preset := ai.PRESETS.get(name[3:-11])):
        return f"AI: {preset[0]}"
    return name


def _style_variant(session_dir: Path, subject: imaging.Image.Image, style: imaging.Style) -> dict:
    name = f"hero_{style.key}.jpg"
    url = _save(session_dir, name, imaging.compose(subject, style))
    return {
        "name": name,
        "url": f"{url}?v={uuid.uuid4().hex[:6]}",
        "style_key": style.key,
        "label": style.label,
        "warnings": style.warnings,
        "ai": False,
    }


@app.get("/api/config")
def get_config():
    return {
        "ai_configured": ai.is_configured(),
        "ai_presets": [{"key": k, "label": v[0], "hero": k not in ai.NON_HERO_PRESETS} for k, v in ai.PRESETS.items()],
    }


@app.post("/api/hero")
def create_hero_variants(file: Annotated[UploadFile, File()]):
    img = _read_upload(file)
    _cleanup_old_sessions()
    session = uuid.uuid4().hex
    session_dir = DATA_DIR / session
    session_dir.mkdir(parents=True)
    (session_dir / AI_SOURCE_NAME).write_bytes(imaging.encode_ai_source(img))

    subject = imaging.trim_background(img)
    return {
        "session": session,
        "ai_configured": ai.is_configured(),
        "default_extra_style": imaging.DEFAULT_EXTRA_STYLE.key,
        "variants": [_style_variant(session_dir, subject, style) for style in imaging.ORIGINAL_STYLES],
    }


@app.post("/api/ai-variants")
def create_ai_variants(
    session: Annotated[str, Form()],
    presets: Annotated[list[str], Form()],
):
    session_dir = _session_dir(session)
    if not ai.is_configured():
        raise HTTPException(503, "AI is not configured. Add POLLINATIONS_API_KEY to the .env file and restart.")
    if not 1 <= len(presets) <= len(ai.PRESETS) or any(p not in ai.PRESETS for p in presets):
        raise HTTPException(400, "Unknown AI preset")
    source_path = session_dir / AI_SOURCE_NAME
    if not source_path.is_file():
        raise HTTPException(404, "Source image not found")
    source = source_path.read_bytes()

    def generate(preset: str) -> imaging.Image.Image | None:
        try:
            return imaging.to_square_canvas(imaging.load_image(ai.edit_image(source, ai.PRESETS[preset][1])))
        except httpx.HTTPStatusError as exc:
            logger.warning("AI generation failed for %s: HTTP %s", preset, exc.response.status_code)
        except (httpx.HTTPError, KeyError, IndexError, ValueError, ai.AIUnavailableError) as exc:
            logger.warning("AI generation failed for %s: %s", preset, type(exc).__name__)
        return None

    with ThreadPoolExecutor(max_workers=min(len(presets), ai.MAX_PARALLEL)) as pool:
        results = list(pool.map(generate, presets))

    variants, failed = [], []
    for preset, img in zip(presets, results):
        label = ai.PRESETS[preset][0]
        if img is None:
            failed.append(label)
            continue
        name = f"ai_{preset}_{uuid.uuid4().hex[:6]}.jpg"
        variants.append({
            "name": name,
            "url": _save(session_dir, name, img),
            "style_key": None,
            "label": f"AI: {label}",
            "warnings": ["AI generated: check the product looks exactly like the real one before uploading"],
            "ai": True,
        })
        if preset == ai.CLEAN_PRESET:
            clean = imaging.trim_background(img)
            framed = [_style_variant(session_dir, clean, style) for style in imaging.CLEAN_STYLES]
            _update_costs(session_dir, remove=tuple(v["name"] for v in framed))
            variants.extend(framed)
    return {"variants": variants, "failed": failed}


@app.get("/api/sessions/latest")
def get_latest_session():
    sources = [p for p in DATA_DIR.glob(f"*/{AI_SOURCE_NAME}") if SESSION_RE.fullmatch(p.parent.name)]
    if not sources:
        raise HTTPException(404, "No session yet. Upload a hero image in the tool first.")
    session_dir = max(sources, key=lambda p: p.stat().st_mtime).parent
    images = sorted(
        (p for p in session_dir.glob("*.jpg") if p.name.startswith(TESTABLE_PREFIXES)),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return {
        "session": session_dir.name,
        "images": [{"name": p.name, "label": _short_label(p.name)} for p in images],
        "costs": _read_costs(session_dir),
    }


class CostReport(BaseModel):
    session: str
    name: str = Field(pattern=NAME_PATTERN)
    cost: float = Field(ge=0, le=100000)
    source: Literal["meesho", "manual"] = "meesho"


@app.post("/api/costs")
def report_cost(report: CostReport):
    session_dir = _session_dir(report.session)
    _session_file(session_dir, report.name)
    _update_costs(session_dir, {report.name: {"cost": report.cost, "source": report.source}})
    return {"ok": True}


@app.delete("/api/costs/{session}/{name}")
def delete_cost(session: str, name: str):
    session_dir = _session_dir(session)
    _session_file(session_dir, name)
    _update_costs(session_dir, remove=(name,))
    return {"ok": True}


@app.get("/api/costs/{session}")
def get_costs(session: str):
    return _read_costs(_session_dir(session))


@app.post("/api/extras")
def create_extra_images(
    session: Annotated[str, Form()],
    style_key: Annotated[str, Form()],
    files: Annotated[list[UploadFile], File()],
):
    session_dir = _session_dir(session)
    style = imaging.STYLES_BY_KEY.get(style_key)
    if style is None:
        raise HTTPException(400, "Unknown style")
    if not 1 <= len(files) <= MAX_EXTRA_FILES:
        raise HTTPException(400, f"Upload between 1 and {MAX_EXTRA_FILES} images")

    start = len(list(session_dir.glob("extra_*.jpg")))
    results = []
    for offset, file in enumerate(files):
        name = f"extra_{start + offset + 1:02d}.jpg"
        subject = imaging.trim_background(_read_upload(file))
        results.append({"name": name, "url": _save(session_dir, name, imaging.compose(subject, style))})
    return {"images": results}


class SheetEntry(BaseModel):
    name: str = Field(pattern=NAME_PATTERN)
    cost: float | None = Field(default=None, ge=0, le=100000)


class SheetRequest(BaseModel):
    session: str
    target: float = Field(default=40, ge=1, le=100000)
    items: list[SheetEntry] = Field(min_length=1, max_length=40)


@app.post("/api/sheet")
def create_comparison_sheet(req: SheetRequest):
    session_dir = _session_dir(req.session)
    entries = sorted(req.items, key=lambda e: (e.cost is None, e.cost or 0))
    has_cost = entries[0].cost is not None
    items = []
    for rank, entry in enumerate(entries, start=1):
        path = _session_file(session_dir, entry.name)
        best = has_cost and rank == 1
        if entry.cost is None:
            title = f"#{rank}  Not tested"
        else:
            title = f"#{rank}  {'USE THIS  ' if best else ''}Rs {entry.cost:g}"
            if entry.cost > req.target:
                title += "  (over)"
        with imaging.Image.open(path) as img:
            img.load()
            items.append(imaging.SheetItem(img, title, _short_label(entry.name), best))
    return Response(imaging.encode_jpeg(imaging.build_sheet(items)), media_type="image/jpeg")


@app.get("/api/image/{session}/{name}")
def get_image(session: str, name: str):
    return FileResponse(_session_file(_session_dir(session), name), media_type="image/jpeg")


@app.get("/api/download/{session}")
def download_zip(session: str, names: Annotated[list[str], Query(max_length=50)]):
    session_dir = _session_dir(session)
    files = [_session_file(session_dir, name) for name in names]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for index, path in enumerate(files, start=1):
            zf.write(path, f"{index:02d}_{path.name}")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="meesho_catalogue.zip"'},
    )


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
