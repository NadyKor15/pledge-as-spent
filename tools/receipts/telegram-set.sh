#!/usr/bin/env bash
# A receipt set as Telegram delivers a photo: at most 1280 px on the long side, JPEG quality 87, 4:2:0 colour.
# Those are the values measured on a photo the bot received (624x1280, Q87, 2x2,1x1,1x1); nothing is sent to Telegram.
# Usage: tools/receipts/telegram-set.sh <set> <out-root>     e.g. holdout .data/receipts-telegram
set -euo pipefail
set_name="$1"; out="$2/$set_name"
mkdir -p "$out"
for png in eval/receipts/"$set_name"/*.png; do
  base="$(basename "$png" .png)"
  # RESAMPLE=on also resamples by 1 % with no filter: the closest match found to a photo the bot received (35 dB,
  # filters and a second JPEG generation stayed at 31-35 dB). A photo already under 1280 px only gets the JPEG step.
  if [ "${RESAMPLE:-}" = on ]; then
    magick "$png" -sample 99% -sampling-factor 4:2:0 -quality 87 "$out/$base.jpg"
  else
    magick "$png" -resize '1280x1280>' -sampling-factor 4:2:0 -quality 87 "$out/$base.jpg"
  fi
done
python3 - "$set_name" "$out" <<'PY'
import hashlib, json, pathlib, subprocess, sys
set_name, out = sys.argv[1], pathlib.Path(sys.argv[2])
for f in sorted(pathlib.Path("eval/receipts", set_name).glob("*.truth.json")):
    t = json.loads(f.read_text(encoding="utf8"))
    jpg = out / (t["image"]["file"].rsplit(".", 1)[0] + ".jpg")
    w, h = subprocess.check_output(["magick", "identify", "-format", "%w %h", str(jpg)]).split()
    t["image"] = {"file": jpg.name, "sha256": hashlib.sha256(jpg.read_bytes()).hexdigest(), "mediaType": "image/jpeg", "width": int(w), "height": int(h)}
    (out / f.name).write_text(json.dumps(t, ensure_ascii=False), encoding="utf8")
PY
ls "$out"/*.jpg | wc -l
