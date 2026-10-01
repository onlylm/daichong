<?php
declare(strict_types=1);

function rfc3986(string $value): string {
    return rawurlencode($value);
}

function canonicalQuery(string $query): string {
    $pairs = [];
    foreach (explode('&', $query) as $part) {
        if ($part === '') continue;
        [$key, $value] = array_pad(explode('=', $part, 2), 2, '');
        $pairs[] = [rfc3986(rawurldecode($key)), rfc3986(rawurldecode($value))];
    }
    usort($pairs, fn($a, $b) => ($a[0] <=> $b[0]) ?: ($a[1] <=> $b[1]));
    return implode('&', array_map(fn($pair) => $pair[0] . '=' . $pair[1], $pairs));
}

function signRequest(string $method, string $url, string $body, int $timestamp, string $nonce, string $keyId, string $idempotencyKey, string $clientSecret): string {
    $parts = parse_url($url);
    $canonical = implode("\n", [
        strtoupper($method),
        $parts['path'] ?? '/',
        canonicalQuery($parts['query'] ?? ''),
        (string)$timestamp,
        $nonce,
        $keyId,
        $idempotencyKey,
        hash('sha256', $body),
    ]);
    return hash_hmac('sha256', $canonical, $clientSecret);
}

$body = json_encode([
    'merchant_order_no' => 'M202609250001',
    'product_code' => 'chatgpt_plus_1m',
    'quantity' => 1,
    'sale_amount' => '135.00',
], JSON_UNESCAPED_SLASHES);

echo signRequest(
    'POST', 'https://sandbox-api.example.invalid/v1/orders', $body,
    1790323200, '00000000-0000-4000-8000-000000000001', 'key_demo_01',
    'checkout_20260925_0001', 'demo_secret_never_use_in_production'
) . PHP_EOL;
