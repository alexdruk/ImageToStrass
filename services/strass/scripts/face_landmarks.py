"""IS (exp-faces, experiment; not used by the service): MediaPipe Face Landmarker (Face Mesh V2,
478 points with the irises; model and library Apache 2.0) on a list of images.

Runs in its own virtual environment, so the service's is untouched:

    /opt/homebrew/bin/python3.12 -m venv .venv-faces
    .venv-faces/bin/pip install mediapipe==0.10.21
    curl -L -o models/mediapipe/face_landmarker.task \
      https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
    .venv-faces/bin/python scripts/face_landmarks.py JOBS.json OUT.json

JOBS.json: [{"id": "...", "path": "...", "blurPx": 0, "confidence": 0.3}, ...]. Each image is composited on white
(transparent pixels become white; EXIF rotation applied), blurred with a Gaussian of blurPx (sigma,
image pixels; 0 = none) and searched for up to MAX_FACES faces, in the whole image and, when its
long side is above CROPS_LONG_SIDE, in overlapping crops too (a small face in a large image is
below the face detector's reach). A face found twice is kept once (the one with the wider eye
distance), and a mesh whose iris centres are closer than MIN_EYE_SHARE of its face width (a face
seen from the side, or a false find) is dropped. confidence: the face detection and presence
confidence asked for (default MIN_CONFIDENCE; higher where no photo confirms the faces). OUT.json: {id: {"w", "h", "faces": [[[x, y], ... 478]]}} in the
image's pixels (continuous, the top-left corner of the image at 0, 0), faces left to right.
"""
import hashlib
import json
import sys
from pathlib import Path

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import FaceLandmarker, FaceLandmarkerOptions, RunningMode
from PIL import Image, ImageFilter, ImageOps

MODEL = Path(__file__).resolve().parent.parent / "models" / "mediapipe" / "face_landmarker.task"
MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
MAX_FACES = 6
CROPS_LONG_SIDE = 700
CROP_SHARE = 0.5
MIN_EYE_SHARE = 0.25
MIN_CONFIDENCE = 0.3
# Face Mesh indices: iris centres and the face's widest points (cheeks at the ears).
IRIS_CENTRES = (468, 473)
FACE_SIDES = (234, 454)


def on_white(path, blur_px):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    white = Image.new("RGBA", im.size, (255, 255, 255, 255))
    rgb = Image.alpha_composite(white, im).convert("RGB")
    if blur_px > 0:
        rgb = rgb.filter(ImageFilter.GaussianBlur(blur_px))
    return np.asarray(rgb)


def detect(landmarker, rgb, x0=0, y0=0):
    h, w = rgb.shape[:2]
    result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    return [[[x0 + p.x * w, y0 + p.y * h] for p in face] for face in result.face_landmarks]


def centre(face):
    return np.asarray(face).mean(axis=0)


def eye_distance(face):
    a, b = (np.asarray(face[i]) for i in IRIS_CENTRES)
    return float(np.hypot(*(a - b)))


def plausible(face):
    a, b = (np.asarray(face[i]) for i in FACE_SIDES)
    return eye_distance(face) >= MIN_EYE_SHARE * float(np.hypot(*(a - b)))


def search(landmarker, rgb):
    found = detect(landmarker, rgb)
    h, w = rgb.shape[:2]
    if max(w, h) > CROPS_LONG_SIDE:
        # Overlapping crops of CROP_SHARE of each side, stepped by half a crop.
        cw, ch = int(w * CROP_SHARE), int(h * CROP_SHARE)
        for y0 in sorted(set(list(range(0, h - ch + 1, max(1, ch // 2))) + [h - ch])):
            for x0 in sorted(set(list(range(0, w - cw + 1, max(1, cw // 2))) + [w - cw])):
                found += detect(landmarker, rgb[y0:y0 + ch, x0:x0 + cw], x0, y0)
    kept = []
    for face in sorted(filter(plausible, found), key=eye_distance, reverse=True):
        # The same face: centres closer than half the larger eye distance.
        if all(np.hypot(*(centre(face) - centre(f))) > 0.5 * eye_distance(f) for f in kept):
            kept.append(face)
    return kept


def landmarker_for(confidence):
    options = FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(MODEL)), running_mode=RunningMode.IMAGE,
        num_faces=MAX_FACES, min_face_detection_confidence=confidence,
        min_face_presence_confidence=confidence, min_tracking_confidence=confidence)
    return FaceLandmarker.create_from_options(options)


def main(jobs_file, out_file):
    if hashlib.sha256(MODEL.read_bytes()).hexdigest() != MODEL_SHA256:
        sys.exit(f"{MODEL} does not have the expected SHA-256")
    out = {}
    landmarkers = {}
    try:
        for job in json.loads(Path(jobs_file).read_text()):
            confidence = float(job.get("confidence", MIN_CONFIDENCE))
            if confidence not in landmarkers:
                landmarkers[confidence] = landmarker_for(confidence)
            rgb = on_white(job["path"], float(job.get("blurPx", 0)))
            faces = sorted(search(landmarkers[confidence], rgb), key=lambda f: centre(f)[0])
            out[job["id"]] = {"w": int(rgb.shape[1]), "h": int(rgb.shape[0]),
                              "faces": [[[round(x, 2), round(y, 2)] for x, y in f] for f in faces]}
    finally:
        for lm in landmarkers.values():
            lm.close()
    Path(out_file).write_text(json.dumps(out))


if __name__ == "__main__":
    main(*sys.argv[1:3])
