#!/usr/bin/env bash
set -euo pipefail

# MediaPipe declares the GUI OpenCV wheel as a dependency. Azure App Service
# Linux does not include GUI libraries such as libxcb, so keep only headless CV2.
python -m pip uninstall -y opencv-python opencv-contrib-python || true
python -m pip install --no-cache-dir --force-reinstall \
  "numpy>=1.24.0,<2.0" \
  "opencv-contrib-python-headless==4.10.0.84"

python - <<'PY'
import cv2
print(f"OpenCV {cv2.__version__} loaded from {cv2.__file__}")
PY
