#!/usr/bin/env python3
"""Offline asset optimization for Red Dead Editor.

Generates compressed WOFF2 font subsets and WebP/resized derivative images
alongside the original assets without deleting or overwriting source files.
"""

from __future__ import annotations

from pathlib import Path
from fontTools.subset import Options, Subsetter, load_font, save_font
from PIL import Image

ASSETS_DIR = Path(__file__).resolve().parent.parent / "frontend" / "assets"

# Cover ASCII, Latin-1 Supplement, Latin Extended-A, Spacing Modifiers,
# General Punctuation (smart quotes, dashes, ellipsis), Arrows, and common symbols.
LATIN_UNICODES = (
    list(range(0x0020, 0x007F))
    + list(range(0x00A0, 0x0180))
    + [0x02C6, 0x02C7, 0x02DC, 0x03BC, 0x03A9]
    + list(range(0x2000, 0x2070))
    + [0x20AC, 0x2190, 0x2191, 0x2192, 0x2193, 0x2194, 0x21B5, 0x2212, 0x2713, 0x2715]
)


def build_woff2(src_woff: Path, dst_woff2: Path) -> None:
    """Subset a WOFF font to Latin/punctuation and emit Brotli WOFF2."""
    options = Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.hinting = True
    options.desubroutinize = False

    font = load_font(str(src_woff), options)
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=LATIN_UNICODES)
    subsetter.subset(font)
    save_font(font, str(dst_woff2), options)


def save_webp_best(img: Image.Image, dst: Path, *, quality: int, alpha_quality: int = 100) -> None:
    """Write a WebP file using high-effort encoding."""
    img.save(
        dst,
        format="WEBP",
        quality=quality,
        alpha_quality=alpha_quality,
        method=6,
    )


def optimize_images() -> None:
    """Convert large background/texture/sprite images to compact WebP derivatives."""
    bg_src = ASSETS_DIR / "background.jpg"
    with Image.open(bg_src) as img:
        rgb = img.convert("RGB")
        if rgb.width > 1600:
            new_h = round(rgb.height * (1600 / rgb.width))
            rgb = rgb.resize((1600, new_h), Image.Resampling.LANCZOS)
        save_webp_best(rgb, ASSETS_DIR / "background.webp", quality=78)

    for png_name, webp_name in [
        ("texturedRed.png", "texturedRed.webp"),
        ("texturedYellow.png", "texturedYellow.webp"),
    ]:
        with Image.open(ASSETS_DIR / png_name) as img:
            rgba = img.convert("RGBA")
            save_webp_best(rgba, ASSETS_DIR / webp_name, quality=90, alpha_quality=100)

    marybeth_dir = ASSETS_DIR / "marybeth"
    for src_webp in sorted(marybeth_dir.glob("*.webp")):
        if src_webp.name.endswith("-sm.webp"):
            continue
        dst_sm = marybeth_dir / f"{src_webp.stem}-sm.webp"
        with Image.open(src_webp) as img:
            rgba = img.convert("RGBA")
            rgba.thumbnail((360, 480), Image.Resampling.LANCZOS)
            save_webp_best(rgba, dst_sm, quality=82, alpha_quality=92)


def main() -> None:
    for woff_name, woff2_name in [("red.woff", "red.woff2"), ("redT.woff", "redT.woff2")]:
        build_woff2(ASSETS_DIR / woff_name, ASSETS_DIR / woff2_name)

    optimize_images()

    report_files = [
        "red.woff",
        "red.woff2",
        "redT.woff",
        "redT.woff2",
        "background.jpg",
        "background.webp",
        "texturedRed.png",
        "texturedRed.webp",
        "texturedYellow.png",
        "texturedYellow.webp",
    ] + [f"marybeth/{p.name}" for p in sorted((ASSETS_DIR / "marybeth").glob("*.webp"))]

    for rel in report_files:
        p = ASSETS_DIR / rel
        if p.exists():
            print(f"{rel:32s} {p.stat().st_size:8d} B")


if __name__ == "__main__":
    main()
