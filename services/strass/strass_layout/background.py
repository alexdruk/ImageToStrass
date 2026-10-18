# IS: new file, not from Rhinestone-Studio.
"""IS: background removal for POST /remove-background (IS-001 spec section 6.2).

rembg with the model REMBG_MODEL names (default below); a model other than the fallback that runs
out of memory is retried with the fallback. Models are read from U2NET_HOME, which defaults to models/rembg
(git-ignored; scripts/setup_mac.sh downloads the model there). A PNG goes in, the same-size RGBA PNG with the background made transparent
comes out. The caller holds the service lock.
"""
import io
import logging
import os
import threading

from PIL import Image

from .errors import BadImage, LayoutError

os.environ.setdefault(
    "U2NET_HOME", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "rembg")
)

MODEL = "birefnet-general"
FALLBACK_MODEL = "isnet-general-use"
MAX_PIXELS = 100_000_000

log = logging.getLogger("strass_layout")
_sessions = {}
_sessions_lock = threading.Lock()


class BackgroundFailed(LayoutError):
    code = "background-failed"
    status = 500


def model_name():
    return os.environ.get("REMBG_MODEL") or MODEL


def load_session(name=None):
    """The rembg session for name (default: model_name()), created on first use only."""
    name = name or model_name()
    with _sessions_lock:
        if name not in _sessions:
            from rembg import new_session

            _sessions[name] = new_session(name)
        return _sessions[name]


def decode(png_bytes):
    try:
        img = Image.open(io.BytesIO(png_bytes))
        if img.format != "PNG":
            raise BadImage("The image is not a PNG.")
        if img.width * img.height > MAX_PIXELS:
            raise BadImage("The image has more than 100 million pixels.")
        return img.convert("RGBA")
    except BadImage:
        raise
    except Exception as exc:
        raise BadImage("The image could not be decoded as a PNG: " + str(exc)) from exc


def remove_background(png_bytes):
    """PNG bytes in, RGBA PNG bytes out (same width and height)."""
    from rembg import remove

    img = decode(png_bytes)
    name = model_name()
    try:
        out = remove(img, session=load_session(name))
    except MemoryError:
        if name == FALLBACK_MODEL:
            raise BackgroundFailed("Out of memory during background removal.")
        log.warning("%s ran out of memory; retrying with %s", name, FALLBACK_MODEL)
        out = remove(img, session=load_session(FALLBACK_MODEL))
    out = out.convert("RGBA")
    if out.size != img.size:
        out = out.resize(img.size)
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()
