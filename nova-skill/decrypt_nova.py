#!/usr/bin/env python3
import json
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

with open('/tmp/nova_decrypt_input.json', 'r') as f:
    data = json.load(f)

encrypted = base64.b64decode(data['encrypted_b64'])
key = base64.b64decode(data['key'])

iv = encrypted[:12]
ciphertext_and_tag = encrypted[12:]

aesgcm = AESGCM(key)
plaintext = aesgcm.decrypt(iv, ciphertext_and_tag, None)

print(plaintext.decode('utf-8'))