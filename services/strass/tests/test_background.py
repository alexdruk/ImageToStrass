# IS: new file, not from Rhinestone-Studio.
"""POST /remove-background (IS-001 spec 6.2): rembg on three sample photos, errors, shared lock.

The photos in tests/fixtures/photos are CC0 (see SOURCES.md there). The client is used without
its lifespan, so the layout models are not loaded; the background model loads on first use.
Set STRASS_BG_OUT to a folder to keep the cut-outs for a visual check.
"""
import io
import os
import threading
import time
import unittest

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

import app as service

PHOTOS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "photos")
PHOTOS = ["dog", "cat", "mug"]


def png_of(name):
    buf = io.BytesIO()
    Image.open(os.path.join(PHOTOS_DIR, name + ".jpg")).convert("RGB").save(buf, "PNG")
    return buf.getvalue()


def post(client, data, content_type="image/png"):
    return client.post("/remove-background", files={"image": ("work.png", data, content_type)})


class RemoveBackground(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(service.app)

    def test_three_photos(self):
        out_dir = os.environ.get("STRASS_BG_OUT")
        for name in PHOTOS:
            with self.subTest(photo=name):
                source = png_of(name)
                r = post(self.client, source)
                self.assertEqual(r.status_code, 200, r.text[:200])
                self.assertEqual(r.headers["content-type"], "image/png")
                img = Image.open(io.BytesIO(r.content))
                self.assertEqual(img.format, "PNG")
                self.assertEqual(img.mode, "RGBA")
                self.assertEqual(img.size, Image.open(io.BytesIO(source)).size)
                alpha = np.array(img)[..., 3]
                transparent = float((alpha < 16).mean())
                opaque = float((alpha > 240).mean())
                # The background goes, the subject stays.
                self.assertGreater(transparent, 0.3, "%s: %.3f transparent" % (name, transparent))
                self.assertGreater(opaque, 0.01, "%s: %.3f opaque" % (name, opaque))
                if out_dir:
                    os.makedirs(out_dir, exist_ok=True)
                    img.save(os.path.join(out_dir, name + "-cutout.png"))

    def test_errors(self):
        r = post(self.client, b"not a png")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "bad-image")

        buf = io.BytesIO()
        Image.new("RGB", (8, 8)).save(buf, "JPEG")
        self.assertEqual(post(self.client, buf.getvalue(), "image/jpeg").json()["error"], "bad-image")

        r = post(self.client, b"\x89PNG" + b"\0" * (service.MAX_IMAGE_BYTES + 1))
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"], "too-large")

        r = self.client.post("/remove-background")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "bad-request")

    def test_waits_for_the_layout_lock(self):
        small = io.BytesIO()
        Image.open(os.path.join(PHOTOS_DIR, "mug.jpg")).convert("RGB").resize((96, 128)).save(small, "PNG")
        done = threading.Event()

        def call():
            post(self.client, small.getvalue())
            done.set()

        with service.layout_lock:
            worker = threading.Thread(target=call)
            worker.start()
            time.sleep(1.0)
            self.assertFalse(done.is_set(), "removal ran while a layout held the lock")
            self.assertIs(self.client.get("/health").json()["busy"], True)
        worker.join(120)
        self.assertTrue(done.is_set())


if __name__ == "__main__":
    unittest.main()
