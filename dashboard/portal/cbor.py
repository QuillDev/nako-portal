"""The small CBOR subset WebAuthn uses: ints, byte/text strings, arrays, maps, simple values."""

from __future__ import annotations

import struct


class CborError(ValueError):
    pass


def decode(data: bytes, offset: int = 0):
    """Decode one item at ``offset``. Returns (value, offset just past it)."""
    if offset >= len(data):
        raise CborError("truncated CBOR")
    initial = data[offset]
    major, info = initial >> 5, initial & 0x1F
    offset += 1
    if major == 7:
        return _simple(data, offset, info)
    length, offset = _argument(data, offset, info)
    if major == 0:
        return length, offset
    if major == 1:
        return -1 - length, offset
    if major in (2, 3):
        end = offset + length
        if end > len(data):
            raise CborError("truncated CBOR string")
        raw = data[offset:end]
        return (raw if major == 2 else raw.decode("utf-8")), end
    if major == 4:
        items = []
        for _ in range(length):
            item, offset = decode(data, offset)
            items.append(item)
        return items, offset
    if major == 5:
        mapping = {}
        for _ in range(length):
            key, offset = decode(data, offset)
            value, offset = decode(data, offset)
            mapping[key] = value
        return mapping, offset
    raise CborError(f"unsupported CBOR major type {major}")


def _argument(data, offset, info):
    if info < 24:
        return info, offset
    sizes = {24: 1, 25: 2, 26: 4, 27: 8}
    if info not in sizes:
        raise CborError("indefinite or reserved CBOR length")
    size = sizes[info]
    if offset + size > len(data):
        raise CborError("truncated CBOR length")
    return int.from_bytes(data[offset : offset + size], "big"), offset + size


def _simple(data, offset, info):
    if info == 20:
        return False, offset
    if info == 21:
        return True, offset
    if info in (22, 23):
        return None, offset
    if info == 25:
        return struct.unpack(">e", data[offset : offset + 2])[0], offset + 2
    if info == 26:
        return struct.unpack(">f", data[offset : offset + 4])[0], offset + 4
    if info == 27:
        return struct.unpack(">d", data[offset : offset + 8])[0], offset + 8
    raise CborError("unsupported CBOR simple value")


def loads(data: bytes):
    value, end = decode(data)
    if end != len(data):
        raise CborError("trailing bytes after CBOR item")
    return value
