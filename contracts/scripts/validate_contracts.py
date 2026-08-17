from __future__ import annotations

from pathlib import Path


REQUIRED_SYMBOLS = (
    'syntax = "proto3";',
    "enum Corridor",
    "CORRIDOR_NIGERIA_NGN",
    "CORRIDOR_KENYA_KES",
    "CORRIDOR_SOUTH_AFRICA_ZAR",
    "enum Stablecoin",
    "STABLECOIN_USDC",
    "STABLECOIN_USDT",
    "message PaymentOrder",
    "message PolicyDecision",
)


def main() -> None:
    contract = Path(__file__).parents[1] / "proto" / "umojaflowos" / "v1" / "domain.proto"
    content = contract.read_text(encoding="utf-8")
    missing = [symbol for symbol in REQUIRED_SYMBOLS if symbol not in content]
    if missing:
        raise SystemExit(f"Contract validation failed; missing: {', '.join(missing)}")
    print(f"validated {contract}")


if __name__ == "__main__":
    main()
