# IS: new file, not from Rhinestone-Studio.
"""Background-removal benchmark (IS-03): one rembg model on the three sample photos.

Run once per model, each in its own process so the peak memory is that model's alone:

    .venv/bin/python scripts/bench_background.py birefnet-general OUT_DIR
    .venv/bin/python scripts/bench_background.py isnet-general-use OUT_DIR

Prints one JSON line (load time, time per photo, peak RSS) and writes OUT_DIR/<photo>-<model>.png.
"""
import io
import json
import os
import resource
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

PHOTOS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures", "photos")
PHOTOS = ["dog", "cat", "mug"]


def peak_rss_mb():
    # ru_maxrss is bytes on macOS, kilobytes on Linux.
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024


def main(model, out_dir):
    os.environ["REMBG_MODEL"] = model
    from strass_layout.background import load_session, remove_background

    os.makedirs(out_dir, exist_ok=True)
    base = peak_rss_mb()
    t0 = time.perf_counter()
    load_session(model)
    load_s = time.perf_counter() - t0
    photos = {}
    for name in PHOTOS:
        buf = io.BytesIO()
        img = Image.open(os.path.join(PHOTOS_DIR, name + ".jpg")).convert("RGB")
        img.save(buf, "PNG")
        t0 = time.perf_counter()
        png = remove_background(buf.getvalue())
        photos[name] = {"seconds": round(time.perf_counter() - t0, 2), "size": list(img.size)}
        with open(os.path.join(out_dir, "%s-%s.png" % (name, model)), "wb") as f:
            f.write(png)
    print(json.dumps({
        "model": model,
        "loadSeconds": round(load_s, 2),
        "photos": photos,
        "peakRssMb": round(peak_rss_mb()),
        "baseRssMb": round(base),
    }))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
