"""Read-only pixel audit. Samples blank UI regions, not text or moving data.

Usage: python tests/meme-trader-colors.py "path/to/reference.png"
This measures selected surfaces; it does NOT assert whole-image equivalence.
"""
import json
import statistics
import sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent / 'artifacts' / 'meme-trader'
reference = Image.open(sys.argv[1]).convert('RGB')
rendered = Image.open(root / 'desktop-light.png').convert('RGB')
regions = {
    'sidebar': (70, 480, 170, 580),
    'page': (554, 349, 870, 356),
    'panel': (270, 445, 650, 451),
    'JEV': (480, 303, 526, 308),
    'CODEX 1': (805, 302, 850, 308),
    'CODEX 2': (1120, 303, 1170, 309),
    'CODEX 3': (1430, 303, 1490, 309),
    'metric': (1030, 485, 1080, 490),
    'JEV track': (470, 229, 480, 235),
    'CODEX 1 track': (795, 229, 805, 235),
    'CODEX 2 track': (1120, 229, 1130, 235),
    'CODEX 3 track': (1440, 229, 1450, 235),
}


def median_rgb(image, box):
    pixels = list(image.crop(box).getdata())
    return [round(statistics.median(p[channel] for p in pixels)) for channel in range(3)]


report = {'reference_size': reference.size, 'render_size': rendered.size,
          'scope': 'Median RGB in 12 fixed blank surface regions only. Not full-image equality.',
          'regions': []}
for name, box in regions.items():
    expected, actual = median_rgb(reference, box), median_rgb(rendered, box)
    delta = [abs(a-b) for a, b in zip(expected, actual)]
    report['regions'].append({'name': name, 'box': box, 'reference_rgb': expected,
                              'render_rgb': actual, 'absolute_rgb_delta': delta})
report['max_channel_delta'] = max(max(r['absolute_rgb_delta']) for r in report['regions'])
report['exact_sample_matches'] = sum(not any(r['absolute_rgb_delta']) for r in report['regions'])
report['whole_image_identical'] = reference.size == rendered.size and reference.tobytes() == rendered.tobytes()
(root / 'color-audit.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
