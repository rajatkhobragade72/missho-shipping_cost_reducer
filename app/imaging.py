"""Image processing: plain-background trimming, canvas composition and comparison sheets.

Meesho does not publish how it derives shipping from the catalogue image, so this
module makes no cost prediction. Variants are only ranked by costs the user reads
from the Meesho Supplier Panel.
"""

import math
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

ASPECTS = {"1:1": (1500, 1500), "3:4": (1200, 1600)}
WHITE = (255, 255, 255)
MIN_SOURCE_SIDE = 300
AI_SOURCE_MAX_SIDE = 1536
BG_TOLERANCE = 24


class InvalidImageError(ValueError):
    pass


@dataclass(frozen=True)
class Style:
    aspect: str
    fill: float
    clean: bool

    @property
    def key(self) -> str:
        return f"{self.aspect.replace(':', 'x')}_{round(self.fill * 100)}_{'clean' if self.clean else 'orig'}"

    @property
    def label(self) -> str:
        source = "AI clean background" if self.clean else "original photo"
        return f"{self.aspect}, product {round(self.fill * 100)}% of frame, white bg, {source}"

    @property
    def short_label(self) -> str:
        return f"{self.aspect} | {round(self.fill * 100)}% | {'AI clean' if self.clean else 'original'}"

    @property
    def warnings(self) -> list[str]:
        if self.clean:
            return ["Made from the AI clean image: check the product looks exactly like the real one"]
        return ["Original background kept if it was not plain; props or background can make the product look bigger"]


ORIGINAL_STYLES: tuple[Style, ...] = (
    Style("1:1", 0.90, False),
    Style("1:1", 0.80, False),
    Style("1:1", 0.65, False),
    Style("3:4", 0.80, False),
)
CLEAN_STYLES: tuple[Style, ...] = tuple(
    Style(aspect, fill, True) for aspect in ASPECTS for fill in (0.90, 0.80, 0.65, 0.50)
)
STYLES_BY_KEY = {s.key: s for s in ORIGINAL_STYLES + CLEAN_STYLES}
DEFAULT_EXTRA_STYLE = Style("1:1", 0.80, True)


def load_image(data: bytes) -> Image.Image:
    try:
        with Image.open(BytesIO(data)) as probe:
            probe.verify()
        img = Image.open(BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise InvalidImageError("Invalid or unsupported image") from exc
    img = ImageOps.exif_transpose(img).convert("RGBA")
    if min(img.size) < MIN_SOURCE_SIDE:
        raise InvalidImageError(f"Image too small, minimum {MIN_SOURCE_SIDE}px on each side")
    return img


def flatten(img: Image.Image) -> Image.Image:
    rgb = Image.new("RGB", img.size, WHITE)
    rgb.paste(img, mask=img.getchannel("A") if img.mode == "RGBA" else None)
    return rgb


def trim_background(img: Image.Image, tolerance: int = BG_TOLERANCE) -> Image.Image:
    """Crops away a plain background whose colour is taken from the image corners."""
    rgb = flatten(img)
    w, h = rgb.size
    corners = [rgb.getpixel(p) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    bbox = diff.point(lambda v: 255 if v > tolerance else 0).getbbox()
    return rgb.crop(bbox) if bbox else rgb


def compose(subject: Image.Image, style: Style) -> Image.Image:
    cw, ch = ASPECTS[style.aspect]
    scale = min(cw * style.fill / subject.width, ch * style.fill / subject.height)
    size = (max(1, round(subject.width * scale)), max(1, round(subject.height * scale)))
    canvas = Image.new("RGB", (cw, ch), WHITE)
    canvas.paste(subject.convert("RGB").resize(size, Image.Resampling.LANCZOS), ((cw - size[0]) // 2, (ch - size[1]) // 2))
    return canvas


def to_square_canvas(img: Image.Image) -> Image.Image:
    return ImageOps.pad(flatten(img), ASPECTS["1:1"], Image.Resampling.LANCZOS, color=WHITE)


def encode_ai_source(img: Image.Image) -> bytes:
    src = flatten(img)
    src.thumbnail((AI_SOURCE_MAX_SIDE, AI_SOURCE_MAX_SIDE), Image.Resampling.LANCZOS)
    buf = BytesIO()
    src.save(buf, "PNG")
    return buf.getvalue()


def encode_jpeg(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, "JPEG", quality=90, optimize=True)
    return buf.getvalue()


@dataclass
class SheetItem:
    image: Image.Image
    title: str
    subtitle: str
    highlight: bool


SHEET_THUMB = 360
SHEET_CAPTION = 96
SHEET_GAP = 16
SHEET_COLUMNS = 4


def build_sheet(items: list[SheetItem]) -> Image.Image:
    """Grid of numbered thumbnails with cost captions, for the seller's own reference only."""
    cols = min(SHEET_COLUMNS, max(1, len(items)))
    rows = math.ceil(len(items) / cols)
    cell_w, cell_h = SHEET_THUMB, SHEET_THUMB + SHEET_CAPTION
    sheet = Image.new(
        "RGB",
        (cols * cell_w + (cols + 1) * SHEET_GAP, rows * cell_h + (rows + 1) * SHEET_GAP),
        (238, 238, 238),
    )
    draw = ImageDraw.Draw(sheet)
    title_font = ImageFont.load_default(size=26)
    sub_font = ImageFont.load_default(size=18)
    for index, item in enumerate(items):
        x = SHEET_GAP + (index % cols) * (cell_w + SHEET_GAP)
        y = SHEET_GAP + (index // cols) * (cell_h + SHEET_GAP)
        thumb = ImageOps.pad(item.image.convert("RGB"), (SHEET_THUMB, SHEET_THUMB), color=WHITE)
        sheet.paste(thumb, (x, y))
        caption_bg = (27, 138, 58) if item.highlight else WHITE
        text_color = WHITE if item.highlight else (20, 20, 20)
        draw.rectangle((x, y + SHEET_THUMB, x + cell_w - 1, y + cell_h - 1), fill=caption_bg)
        draw.text((x + 10, y + SHEET_THUMB + 10), item.title, font=title_font, fill=text_color)
        draw.text((x + 10, y + SHEET_THUMB + 50), item.subtitle[:40], font=sub_font, fill=text_color)
        if item.highlight:
            draw.rectangle((x - 4, y - 4, x + cell_w + 3, y + cell_h + 3), outline=(27, 138, 58), width=6)
    return sheet
