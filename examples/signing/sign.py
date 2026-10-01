from __future__ import annotations

import hashlib
import hmac
import json
from urllib.parse import quote, unquote, urlsplit


def canonical_query(query: str) -> str:
    pairs = []
    for part in filter(None, query.split("&")):
        key, separator, value = part.partition("=")
        pairs.append((quote(unquote(key), safe="~-._"), quote(unquote(value if separator else ""), safe="~-._")))
    pairs.sort()
    return "&".join(f"{key}={value}" for key, value in pairs)


def sign_request(*, method: str, url: str, body: str, timestamp: int, nonce: str,
                 key_id: str, idempotency_key: str, client_secret: str) -> str:
    parsed = urlsplit(url)
    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    canonical = "\n".join([
        method.upper(), parsed.path or "/", canonical_query(parsed.query), str(timestamp),
        nonce, key_id, idempotency_key, body_hash,
    ])
    return hmac.new(client_secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


if __name__ == "__main__":
    body = json.dumps({
        "merchant_order_no": "M202609250001",
        "product_code": "chatgpt_plus_1m",
        "quantity": 1,
        "sale_amount": "135.00",
    }, separators=(",", ":"), ensure_ascii=False)
    print(sign_request(
        method="POST",
        url="https://sandbox-api.example.invalid/v1/orders",
        body=body,
        timestamp=1790323200,
        nonce="00000000-0000-4000-8000-000000000001",
        key_id="key_demo_01",
        idempotency_key="checkout_20260925_0001",
        client_secret="demo_secret_never_use_in_production",
    ))
