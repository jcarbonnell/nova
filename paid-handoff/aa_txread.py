#!/usr/bin/env python3
"""
aa_txread.py: read one NEAR mainnet transaction and print its signer, every FunctionCall
(method + decoded args) and every log / NEP-297 event, per receipt. Read-only, no secrets.

    .venv/bin/python aa_txread.py <tx_hash> <signer_account_id>
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aa_observe import fetch_tx, summarize_tx  # noqa: E402
from aa_setup import import_asset  # noqa: E402
import json  # noqa: E402

if len(sys.argv) != 3:
    sys.exit("usage: aa_txread.py <tx_hash> <signer_account_id>")
m = import_asset()
url = os.environ.get("NEAR_RPC_URL", "https://free.rpc.fastnear.com")
res = fetch_tx(m, url, sys.argv[1], [sys.argv[2]])
print(json.dumps(summarize_tx(res), indent=2) if res else "tx not found for that signer")