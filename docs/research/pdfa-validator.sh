#!/bin/sh
# Rebuild the veraPDF CLI this round measured with, then run it on a file.
#
#   sh docs/research/pdfa-validator.sh 2b /tmp/r28/before.pdf
#
# veraPDF is the only PDF/A validator that exists, and it is not in the box: 1.28.2
# is a 12 MB installer whose app pack is a zip with no central directory, so it is
# repacked here entry by entry. OpenJDK 27 is on the machine; nothing else is
# needed and nothing is installed system-wide.
set -e
FLAVOUR=${1:?flavour, e.g. 2b}
FILE=${2:?a PDF}
JAR=${VERAPDF_JAR:-/tmp/verapdf/verapdf-gui.jar}
if [ ! -f "$JAR" ]; then
  mkdir -p /tmp/verapdf
  curl -sL --max-time 900 \
    "https://software.verapdf.org/releases/1.28/verapdf-greenfield-1.28.2-installer.zip" \
    -o /tmp/verapdf/installer.zip
  unzip -q -o /tmp/verapdf/installer.zip -d /tmp/verapdf/vr
  unzip -q -o "/tmp/verapdf/vr/verapdf-greenfield-1.28.2/verapdf-izpack-installer-1.28.2.jar" \
    'resources/packs/pack-veraPDF GUI' -d /tmp/verapdf/x
  python3 - "$JAR" <<'PY'
import struct, sys, zipfile, zlib
d = open('/tmp/verapdf/x/resources/packs/pack-veraPDF GUI', 'rb').read()
out = zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED)
off = 0
while off < len(d) and d[off:off + 4] == b'PK\x03\x04':
    _, _, flag, comp, _, _, _, csz, _, fnl, exl = struct.unpack('<IHHHHHIIIHH', d[off:off + 30])
    name = d[off + 30:off + 30 + fnl].decode('utf-8')
    start = off + 30 + fnl + exl
    raw = d[start:start + csz]
    off = start + csz + (16 if flag & 8 else 0)
    if name.endswith('/'):
        out.writestr(zipfile.ZipInfo(name), b'')
        continue
    out.writestr(name, zlib.decompress(raw, -15) if comp == 8 else raw)
out.close()
PY
fi
exec java -cp "$JAR" org.verapdf.apps.GreenfieldCliWrapper -f "$FLAVOUR" -v "$FILE"
