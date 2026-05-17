#!/usr/bin/env python3
# Python prototype of Layer 3 (RSD enumerate services) against an iOS 17+
# device whose tunnel is brought up by `xcrun devicectl device info ddiServices`.
#
# This is a reference for porting to TypeScript. To run:
#
#   pip3 install construct hyperframe
#   # in another terminal: xcrun devicectl device info processes --device <UDID>
#   python3 probe.py <DEVICE_HOSTNAME>
#
# where DEVICE_HOSTNAME = <coredevice-identifier-lowercased>.coredevice.local
# (resolves to the device's tunnel IPv6). The RSD port is captured from
# `log stream` so this script also needs `log` access (default on macOS).
#
# Output: prints peer_info.Services dict — { service_name: { Port: N, Properties: {...} } }
# for all 74-ish services the device exposes over the tunnel.
#
# The whole point: NO sudo, NO USB, NO pair-record crypto. We're inside the
# encrypted CoreDevice tunnel that macOS already established. RSD speaks
# plain HTTP/2 (no TLS) inside that tunnel — the key trick is binding the
# source socket to the Mac end of the tunnel (fd<prefix>::2 from ifconfig).

import socket
import struct
import subprocess
import sys
import time

try:
    from pymobiledevice3.remote.xpc_message import (
        XpcFlags,
        XpcWrapper,
        create_xpc_wrapper,
        decode_xpc_object,
    )
except ImportError:
    sys.exit("pip3 install construct hyperframe; clone pymobiledevice3 to /tmp/pymd3")


def find_tunnel_source() -> str:
    # the utun interface with MTU 16000 is the CoreDevice tunnel; its IPv6
    # in the same fd<prefix>::/64 as the device is the source we need.
    out = subprocess.check_output(["ifconfig"], text=True)
    iface = None
    pending = False
    for line in out.splitlines():
        if line.startswith("utun"):
            iface = line.split(":")[0]
            pending = False
        elif "mtu 16000" in line:
            pending = True
        elif pending and "inet6 fd" in line:
            return line.split()[1]
    sys.exit("no tunnel utun interface found")


def find_rsd_port() -> int:
    # remotepairingd logs `Creating RSD backend client device for server port <N>`
    out = subprocess.check_output(
        ["log", "show", "--last", "30s", "--info", "--debug",
         "--predicate", 'eventMessage CONTAINS "for server port"',
         "--style", "compact"],
        text=True,
    )
    for line in reversed(out.splitlines()):
        if "for server port" in line:
            return int(line.rsplit("server port", 1)[1].strip().split()[0])
    sys.exit("no 'for server port' log line — is the tunnel up?")


def h2_frame(ftype: int, flags: int, stream_id: int, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload))[1:]
            + bytes([ftype, flags])
            + struct.pack(">I", stream_id)
            + payload)


def open_rsd(device_addr: str, source_addr: str, rsd_port: int) -> socket.socket:
    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    s.bind((source_addr, 0, 0, 0))
    s.connect((device_addr, rsd_port, 0, 0))
    s.settimeout(5.0)
    return s


def handshake(s: socket.socket) -> None:
    empty_dict = create_xpc_wrapper({}, message_id=0, wanting_reply=False)
    init_handshake = XpcWrapper.build({
        "flags": XpcFlags.ALWAYS_SET | XpcFlags.INIT_HANDSHAKE,
        "message": {"message_id": 0, "payload": None},
    })
    batch = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
    # SETTINGS (MAX_CONCURRENT_STREAMS=100, INITIAL_WINDOW_SIZE=1048576)
    batch += h2_frame(0x04, 0x00, 0,
                      struct.pack(">HI", 3, 100) + struct.pack(">HI", 4, 1048576))
    # WINDOW_UPDATE on stream 0
    batch += h2_frame(0x08, 0x00, 0, struct.pack(">I", 983041))
    # ROOT_CHANNEL: empty HEADERS + DATA with empty XPC dict
    batch += h2_frame(0x01, 0x04, 1, b"") + h2_frame(0x00, 0x00, 1, empty_dict)
    # REPLY_CHANNEL: empty HEADERS + DATA with INIT_HANDSHAKE wrapper
    batch += h2_frame(0x01, 0x04, 3, b"") + h2_frame(0x00, 0x00, 3, init_handshake)
    s.sendall(batch)


def collect_stream1(s: socket.socket, deadline: float) -> bytes:
    buf = b""
    while time.time() < deadline:
        try:
            s.settimeout(max(0.2, deadline - time.time()))
            d = s.recv(16384)
            if not d:
                break
            buf += d
        except (socket.timeout, ConnectionResetError):
            break
    out = b""
    i = 0
    while i + 9 <= len(buf):
        flen = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]
        ftype, fstream = buf[i + 3], int.from_bytes(buf[i + 5:i + 9], "big")
        if i + 9 + flen > len(buf):
            break
        if ftype == 0x00 and fstream == 1:
            out += buf[i + 9:i + 9 + flen]
        i += 9 + flen
    return out


def parse_xpc_wrappers(stream_data: bytes) -> list:
    # Walk concatenated XpcWrappers. Each wrapper:
    #   header (16) = magic(4) + flags(4) + msg_len(8)
    #   inner = msg_len + 8 bytes  (pymd3's ExprAdapter is +8 on parse)
    out = []
    pos = 0
    while pos + 16 <= len(stream_data):
        magic, _flags, msg_len = struct.unpack("<IIQ", stream_data[pos:pos + 16])
        if magic != 0x29B00B92:
            break
        total = 16 + msg_len + 8
        if pos + total > len(stream_data):
            break
        wrap = XpcWrapper.parse(stream_data[pos:pos + total])
        if wrap.message.payload is not None:
            obj = decode_xpc_object(wrap.message.payload.obj)
            if isinstance(obj, dict):
                out.append(obj)
        pos += total
    return out


def main(device_hostname: str) -> None:
    addr_info = socket.getaddrinfo(device_hostname, None, socket.AF_INET6)
    device_addr = addr_info[0][4][0]
    source_addr = find_tunnel_source()
    rsd_port = find_rsd_port()
    print(f"device={device_addr} source={source_addr} rsd={rsd_port}")

    s = open_rsd(device_addr, source_addr, rsd_port)
    handshake(s)
    raw = collect_stream1(s, time.time() + 3)
    s.close()

    for payload in parse_xpc_wrappers(raw):
        if "Services" in payload:
            services = payload["Services"]
            print(f"\nServices ({len(services)}):")
            for name in sorted(services):
                info = services[name]
                port = info.get("Port", "?") if isinstance(info, dict) else info
                print(f"  {name}: {port}")
            return
    sys.exit("no Services dict in any received XPC payload")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} <udid-lowercased>.coredevice.local")
    main(sys.argv[1])
