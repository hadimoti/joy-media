"""Generate deterministic transparent PNG fixtures used by the test suite."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


def canvas(width: int = 320, height: int = 180) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    return image, ImageDraw.Draw(image)


def generate(output: Path) -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []

    image, draw = canvas()
    draw.rounded_rectangle((30, 40, 130, 130), radius=12, fill=(232, 68, 55, 255))
    paths.append(output / "single-object.png")
    image.save(paths[-1])

    image, draw = canvas()
    draw.ellipse((24, 45, 94, 115), fill=(244, 184, 32, 255))
    draw.rounded_rectangle((205, 44, 285, 116), radius=12, fill=(31, 120, 239, 255))
    paths.append(output / "multiple-independent.png")
    image.save(paths[-1])

    image, draw = canvas()
    draw.ellipse((45, 34, 180, 105), fill=(244, 244, 244, 255))
    draw.ellipse((57, 115, 185, 136), fill=(0, 0, 0, 115))
    paths.append(output / "detached-shadow.png")
    image.save(paths[-1])

    image, draw = canvas()
    draw.ellipse((70, 32, 222, 164), fill=(55, 172, 255, 12))
    draw.ellipse((94, 55, 198, 141), fill=(55, 172, 255, 255))
    paths.append(output / "low-alpha-glow.png")
    image.save(paths[-1])

    image, draw = canvas()
    # H, i (including detached dot), and I form a compact text graphic.
    draw.rectangle((42, 62, 48, 128), fill=(255, 255, 255, 255))
    draw.rectangle((68, 62, 74, 128), fill=(255, 255, 255, 255))
    draw.rectangle((48, 88, 68, 96), fill=(255, 255, 255, 255))
    draw.rectangle((85, 82, 92, 128), fill=(255, 255, 255, 255))
    draw.rectangle((86, 65, 90, 69), fill=(255, 255, 255, 255))
    draw.rectangle((103, 62, 110, 128), fill=(255, 255, 255, 255))
    paths.append(output / "text-dotted-letter.png")
    image.save(paths[-1])

    image, draw = canvas()
    draw.rectangle((64, 48, 180, 144), fill=(105, 222, 112, 255))
    draw.point((6, 6), fill=(255, 255, 255, 255))
    draw.point((12, 12), fill=(255, 255, 255, 10))
    paths.append(output / "noise-filter.png")
    image.save(paths[-1])

    image, draw = canvas(600, 600)
    for row in range(11):
        for column in range(11):
            x, y = 12 + column * 52, 12 + row * 52
            draw.rectangle((x, y, x + 12, y + 12), fill=(255, 255, 255, 255))
    paths.append(output / "many-objects.png")
    image.save(paths[-1])

    image, draw = canvas(720, 360)
    for column in range(180):
        x = 36 + (column * 31) % 648
        y = 72 + ((column * 47) % 174)
        draw.ellipse((x, y, x + 3, y + 3), fill=(255, 196, 44, 255))
    paths.append(output / "particle-field.png")
    image.save(paths[-1])

    image, draw = canvas(720, 360)
    draw.rounded_rectangle((36, 48, 230, 218), radius=16, fill=(232, 68, 55, 255))
    for row in range(15):
        for column in range(12):
            x, y = 420 + column * 18, 52 + row * 18
            draw.ellipse((x, y, x + 3, y + 3), fill=(255, 196, 44, 255))
    paths.append(output / "mixed-particle-sheet.png")
    image.save(paths[-1])

    image, draw = canvas(720, 360)
    for column in range(5):
        x = 42 + column * 20
        draw.rectangle((x, 60, x + 4, 180), fill=(25, 218, 132, 255))
    draw.rounded_rectangle((420, 80, 610, 230), radius=18, fill=(72, 123, 230, 255))
    paths.append(output / "composition-cluster.png")
    image.save(paths[-1])

    image, draw = canvas(900, 900)
    for row in range(10):
        for column in range(10):
            x, y = 40 + column * 80, 42 + row * 80
            draw.rectangle((x + 11, y, x + 23, y + 62), fill=(26, 182, 79, 255))
            draw.rectangle((x, y + 12, x + 34, y + 24), fill=(26, 182, 79, 255))
            draw.rectangle((x, y + 39, x + 34, y + 51), fill=(26, 182, 79, 255))
    paths.append(output / "repeating-pattern.png")
    image.save(paths[-1])

    image, draw = canvas(920, 620)
    draw.rounded_rectangle((24, 24, 136, 76), radius=8, fill=(34, 158, 230, 255))
    # A deliberately sparse field of uniform dots: this represents a map-like
    # illustration, not hundreds of independent icons.
    for row in range(26):
        for column in range(24):
            if (column * 3 + row * 5) % 11 in (0, 1):
                continue
            x, y = 220 + column * 24, 16 + row * 23
            draw.ellipse((x, y, x + 9, y + 9), fill=(154, 154, 154, 255))
    paths.append(output / "uniform-dot-field.png")
    image.save(paths[-1])

    image, draw = canvas()
    draw.rectangle((0, 0, 56, 74), fill=(190, 74, 229, 255))
    paths.append(output / "edge-object.png")
    image.save(paths[-1])

    image, draw = canvas()
    draw.ellipse((70, 45, 200, 145), fill=(84, 195, 255, 18))
    paths.append(output / "semi-transparent-only.png")
    image.save(paths[-1])

    opaque = Image.new("RGB", (100, 100), (255, 255, 255))
    paths.append(output / "fully-opaque.png")
    opaque.save(paths[-1])
    return paths


if __name__ == "__main__":
    generate(Path(__file__).resolve().parents[1] / "tests" / "fixtures")
