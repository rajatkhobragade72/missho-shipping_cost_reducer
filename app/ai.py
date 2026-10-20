"""AI hero-image variants via the Pollinations image edit API.

The API key is read from the POLLINATIONS_API_KEY environment variable and is never
returned to the browser. Behind a TLS-intercepting proxy set SSL_CERT_FILE to the
corporate CA bundle.
"""

import base64
import os

import httpx

API_URL = "https://gen.pollinations.ai/v1/images/edits"
DEFAULT_MODEL = "black-forest-labs/flux.2-klein-4b"
TIMEOUT_SECONDS = 180

_KEEP = (
    "Keep the product exactly the same: same shape, colours, print, quantity and branding. "
    "No text, no badges, no watermark, no hands, no extra objects. Square 1:1 image."
)
CLEAN_PRESET = "clean-white"
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
}
PRESETS = {key: (label, f"{prompt} {_KEEP}") for key, (label, prompt) in PRESETS.items()}


class AIUnavailableError(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(os.environ.get("POLLINATIONS_API_KEY"))


def edit_image(image_png: bytes, prompt: str) -> bytes:
    key = os.environ.get("POLLINATIONS_API_KEY")
    if not key:
        raise AIUnavailableError("POLLINATIONS_API_KEY is not set")
    response = httpx.post(
        API_URL,
        headers={"Authorization": f"Bearer {key}"},
        files={"image": ("product.png", image_png, "image/png")},
        data={
            "prompt": prompt,
            "model": os.environ.get("POLLINATIONS_IMAGE_MODEL", DEFAULT_MODEL),
            "size": "1024x1024",
            "response_format": "b64_json",
        },
        timeout=TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return base64.b64decode(response.json()["data"][0]["b64_json"], validate=True)
