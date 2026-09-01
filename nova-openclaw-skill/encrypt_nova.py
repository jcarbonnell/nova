#!/usr/bin/env python3
"""AES-256-GCM encryption helper for NOVA file uploads.

Usage: python3 encrypt_nova.py <key_b64> <input_file>
Outputs base64-encoded encrypted payload to stdout.
"""
import json
import base64
import sys
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

if len(sys.argv) < 3:
    print("Usage: encrypt_nova.py <key_b64> <input_file>", file=sys.stderr)
    sys.exit(1)

key = base64.b64decode(sys.argv[1])
input_file = sys.argv[2]

with open(input_file, 'rb') as f:
    plaintext = f.read()

iv = os.urandom(12)
aesgcm = AESGCM(key)
ciphertext_and_tag = aesgcm.encrypt(iv, plaintext, None)

# Format: IV (12 bytes) + ciphertext+tag
encrypted = iv + ciphertext_and_tag
print(base64.b64encode(encrypted).decode('utf-8'))