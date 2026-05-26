#!/usr/bin/env python3
"""AES-256-GCM decryption helper for NOVA encrypted files."""
import json
import base64
import sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

input_file = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nova_decrypt_input.json'

with open(input_file, 'r') as f:
    data = json.load(f)

encrypted = base64.b64decode(data['encrypted_b64'])
key = base64.b64decode(data['key'])

iv = encrypted[:12]
ciphertext_and_tag = encrypted[12:]

aesgcm = AESGCM(key)
plaintext = aesgcm.decrypt(iv, ciphertext_and_tag, None)
print(plaintext.decode('utf-8'))