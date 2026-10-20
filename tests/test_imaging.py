from io import BytesIO

import pytest
from PIL import Image

from app import imaging


def _png(size=(600, 400), color=(200, 30, 30, 255)) -> bytes:
    buf = BytesIO()
    Image.new("RGBA", size, color).save(buf, "PNG")
    return buf.getvalue()


def test_load_image_rejects_garbage():
    with pytest.raises(imaging.InvalidImageError):
        imaging.load_image(b"not an image")


def test_load_image_rejects_tiny_image():
    with pytest.raises(imaging.InvalidImageError):
        imaging.load_image(_png((100, 100)))


@pytest.mark.parametrize("bg", [(255, 255, 255), (180, 160, 140)])
def test_trim_background_crops_plain_background(bg):
    img = Image.new("RGBA", (500, 500), bg + (255,))
    img.paste((20, 60, 200, 255), (100, 150, 300, 250))
    assert imaging.trim_background(img).size == (200, 100)


def test_trim_background_handles_transparency():
    img = Image.new("RGBA", (500, 500), (0, 0, 0, 0))
    img.paste((255, 0, 0, 255), (100, 150, 300, 250))
    assert imaging.trim_background(img).size == (200, 100)


@pytest.mark.parametrize("style", imaging.ORIGINAL_STYLES + imaging.CLEAN_STYLES, ids=lambda s: s.key)
def test_compose_respects_canvas_and_fill(style):
    subject = Image.new("RGB", (800, 400), (10, 10, 10))
    canvas = imaging.compose(subject, style)
    cw, ch = imaging.ASPECTS[style.aspect]
    assert canvas.size == (cw, ch) and canvas.mode == "RGB"
    assert canvas.getpixel((0, 0)) == imaging.WHITE
    bbox = Image.eval(canvas.convert("L"), lambda p: 255 if p < 100 else 0).getbbox()
    assert bbox[2] - bbox[0] == pytest.approx(cw * style.fill, abs=2)


def test_to_square_canvas_pads_to_white_square():
    out = imaging.to_square_canvas(Image.new("RGBA", (1024, 512), (0, 0, 255, 255)))
    assert out.size == imaging.ASPECTS["1:1"]
    assert out.getpixel((0, 0)) == imaging.WHITE


def test_build_sheet_layout():
    items = [imaging.SheetItem(Image.new("RGB", (500, 500)), f"#{i}", "x", i == 0) for i in range(6)]
    sheet = imaging.build_sheet(items)
    cols, rows = 4, 2
    assert sheet.width == cols * imaging.SHEET_THUMB + (cols + 1) * imaging.SHEET_GAP
    assert sheet.height == rows * (imaging.SHEET_THUMB + imaging.SHEET_CAPTION) + (rows + 1) * imaging.SHEET_GAP


def test_style_keys_are_unique_and_default_is_known():
    assert len(imaging.STYLES_BY_KEY) == len(imaging.ORIGINAL_STYLES) + len(imaging.CLEAN_STYLES)
    assert imaging.DEFAULT_EXTRA_STYLE.key in imaging.STYLES_BY_KEY
