import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from persistence.base import validate_uid

# NTAG21x (7 bytes / 14 chars)
assert validate_uid('04A1B2C3D4E5F6') == '04A1B2C3D4E5F6'
# Mifare Classic (4 bytes / 8 chars)
assert validate_uid('04A1B2C3') == '04A1B2C3'
# lowercase + spaces normalize
assert validate_uid('  04a1b2c3d4e5f6 ') == '04A1B2C3D4E5F6'
# prefix stripped
assert validate_uid('BR-04A1B2C3D4E5F6', 'BR-') == '04A1B2C3D4E5F6'

# 20 chars (10 bytes) IS valid per spec — only >20 is rejected
assert validate_uid('04A1B2C3D4E5F67890') == '04A1B2C3D4E5F67890'

# rejects: odd length, too short, too long, non-hex
for bad in ['04A1B2C3D4E5F', '04A1B2C3D4E5F67890ABCD', '04A1B2C3D4E5F6G', 'GHIJ', '']:
    try:
        validate_uid(bad)
        raise SystemExit(f'should have rejected: {bad!r}')
    except ValueError:
        pass

print('PY VALIDATE_UID OK')
