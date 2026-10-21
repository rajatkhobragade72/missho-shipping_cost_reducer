"""AI hero-image variants via the Pollinations image edit API.

The API key is read from the POLLINATIONS_API_KEY environment variable and is never
returned to the browser. Behind a TLS-intercepting proxy the Windows certificate store
is used automatically via truststore so no extra configuration is needed.
"""

import base64
import os
import ssl

import httpx
import truststore

API_URL = "https://gen.pollinations.ai/v1/images/edits"
DEFAULT_MODEL = "black-forest-labs/flux.2-klein-4b"
TIMEOUT_SECONDS = 180

_KEEP = (
    "Use the exact same product from the photo: identical fabric texture and weave, stitching, colours, "
    "print, size, proportions and quantity. Do not redraw, restyle, resize or simplify the product. "
    "Remove every piece of text, offer banner, sticker, badge, logo and watermark that is in the input "
    "(for example 'Buy 1 Get 1 Free'); the output must contain no text or letters at all."
)
_STUDIO = "No hands, no extra objects. Square 1:1 image."
CLEAN_PRESET = "clean-white"
LIFESTYLE_PRESET = "lifestyle"
MAX_PARALLEL = 6
_WHITE = "on a plain pure white background, centered"
PRESETS: dict[str, tuple[str, str]] = {
    CLEAN_PRESET: ("Clean white studio", f"Place this product {_WHITE}, soft even studio light, no shadow."),
    "compact": ("Compact / neatly folded", f"Show this product neatly folded or arranged compactly so it looks small and tidy, {_WHITE}."),
    "elevated": ("Slightly elevated angle", f"Show this product from a slightly elevated front angle, compact framing, {_WHITE}."),
    "angle-34": ("3/4 angle", f"Show this product from a three-quarter front angle {_WHITE}."),
    "top-view": ("Top view, compact", f"Top-down view of this product arranged compactly {_WHITE}."),
    "side-view": ("Side view", f"Side view of this product {_WHITE}."),
    "front-tight": ("Front, fills frame", f"Straight front view of this product filling about 85% of the frame {_WHITE}."),
    "closeup": ("Close-up detail", f"Close-up of this product showing texture, filling most of the frame {_WHITE}."),
    "soft-shadow": ("White + soft shadow", f"Place this product {_WHITE}, with a soft natural shadow under it."),
    "light-grey": ("Light grey studio", "Place this product on a plain light grey studio background, centered, soft light."),
    "pastel": ("Soft pastel background", "Place this product on a plain soft pastel background, centered, gentle studio light."),
    "podium": ("Small white podium", "Place this product on a small plain white podium against a plain white background, centered."),
    LIFESTYLE_PRESET: ("Daily use (lifestyle)", "Show this product in real everyday use in a clean, bright Indian home, for example a hand using it "
                       "to wipe a kitchen counter or table. Natural light, realistic photo, product clearly visible. Square 1:1 image."),
}
# Lifestyle shots may show hands/props and are never used as the hero (cover) photo.
NON_HERO_PRESETS = frozenset({LIFESTYLE_PRESET})
PRESETS = {
    key: (label, f"{prompt} {_KEEP}" + ("" if key in NON_HERO_PRESETS else f" {_STUDIO}"))
    for key, (label, prompt) in PRESETS.items()
}


HF_ROUTER_URL = "https://router.huggingface.co/hf-inference/models"
DEFAULT_HF_MODEL = "timbrooks/instruct-pix2pix"


class AIUnavailableError(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(os.environ.get("HF_TOKEN") or os.environ.get("POLLINATIONS_API_KEY"))


def _ssl_context() -> ssl.SSLContext:
    """Return an SSL context that trusts the Windows certificate store (corporate proxy)."""
    ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    return ctx


def _edit_image_hf(image_png: bytes, prompt: str, token: str) -> bytes:
    model = os.environ.get("HF_IMAGE_MODEL", DEFAULT_HF_MODEL)
    url = f"{HF_ROUTER_URL}/{model}"
    headers = {"Authorization": f"Bearer {token}"}
    b64_img = base64.b64encode(image_png).decode("utf-8")
    payload = {
        "inputs": b64_img,
        "parameters": {"prompt": prompt},
    }
    with httpx.Client(verify=_ssl_context(), timeout=TIMEOUT_SECONDS) as client:
        for _ in range(3):
            response = client.post(url, headers=headers, json=payload)
            if response.status_code == 503 and "loading" in response.text:
                import time
                try:
                    data = response.json()
                    wait_sec = min(20, max(5, int(data.get("estimated_time", 10))))
                except Exception:
                    wait_sec = 10
                time.sleep(wait_sec)
                continue
            response.raise_for_status()
            return response.content
        response.raise_for_status()
        return response.content


def _edit_image_pollinations(image_png: bytes, prompt: str, key: str) -> bytes:
    with httpx.Client(verify=_ssl_context(), timeout=TIMEOUT_SECONDS) as client:
        response = client.post(
            API_URL,
            headers={"Authorization": f"Bearer {key}"},
            files={"image": ("product.png", image_png, "image/png")},
            data={
                "prompt": prompt,
                "model": os.environ.get("POLLINATIONS_IMAGE_MODEL", DEFAULT_MODEL),
                "size": "1024x1024",
                "response_format": "b64_json",
            },
        )
        response.raise_for_status()
        return base64.b64decode(response.json()["data"][0]["b64_json"], validate=True)


def edit_image(image_png: bytes, prompt: str) -> bytes:
    hf_token = os.environ.get("HF_TOKEN")
    if hf_token:
        return _edit_image_hf(image_png, prompt, hf_token)
    polli_key = os.environ.get("POLLINATIONS_API_KEY")
    if polli_key:
        return _edit_image_pollinations(image_png, prompt, polli_key)
    raise AIUnavailableError("Neither HF_TOKEN nor POLLINATIONS_API_KEY is set in .env")

