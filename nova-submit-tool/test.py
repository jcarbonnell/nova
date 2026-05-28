import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

key = base64.b64decode("nXNCPQRtF7qp9ofLiZJmCa5HysNRD58iyojAQnlAztA=")
blob = base64.b64decode("m21zt6XKbPfcoENzJPw8wp3+G0VV+5YCsIaV2X/hXPppueG1WYAwVlRFxjjocqG/UdA=")
iv = blob[:12]
ct = blob[12:]
print(AESGCM(key).decrypt(iv, ct, None).decode())