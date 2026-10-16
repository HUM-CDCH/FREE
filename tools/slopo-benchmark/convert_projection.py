from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    value = torch.load(args.source, map_location="cpu", weights_only=True)
    if isinstance(value, dict):
        tensors = [item for item in value.values() if isinstance(item, torch.Tensor)]
        if len(tensors) != 1:
            raise ValueError(f"Expected one projection tensor, found {len(tensors)}")
        value = tensors[0]
    if not isinstance(value, torch.Tensor) or value.ndim != 2:
        raise ValueError(f"Unexpected projection payload: {type(value)!r}")

    args.destination.parent.mkdir(parents=True, exist_ok=True)
    np.save(args.destination, value.detach().float().cpu().numpy())
    print(f"Saved projection {tuple(value.shape)} to {args.destination}")


if __name__ == "__main__":
    main()
