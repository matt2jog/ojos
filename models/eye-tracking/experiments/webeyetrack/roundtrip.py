"""Measure a bounded 20 Hz upload queue over a single SSH connection using public JPEGs."""
import argparse
import json
import os
from pathlib import Path
import shlex
import struct
import subprocess
import sys
from threading import Condition, Thread
from time import perf_counter, sleep

HEADER = struct.Struct(">I")


def server(upstream):
    import cv2
    import numpy as np
    import tensorflow as tf
    from native import Native

    cv2.setNumThreads(1)
    model = Native(upstream, video=False, variant="both")
    if os.environ.get("OJOS_TF_DEVICE") == "/GPU:0" and not tf.config.list_logical_devices("GPU"):
        raise RuntimeError("Expected a GPU for this public upload probe")
    print(json.dumps({"ready": True}), flush=True)
    stream = sys.stdin.buffer
    while header := stream.read(HEADER.size):
        size, = HEADER.unpack(header)
        if not size:
            return
        value = stream.read(size)
        if len(value) != size:
            raise EOFError("Partial JPEG payload")
        started = perf_counter()
        rgb = cv2.imdecode(np.frombuffer(value, dtype=np.uint8), cv2.IMREAD_COLOR_RGB)
        prep_ms = (perf_counter() - started) * 1000
        result = model.step(rgb, 0, prep_ms)
        print(json.dumps({"service_ms": (perf_counter() - started) * 1000,
                          "model_ms": result["modelMs"], "observed": bool(result.get("wet"))}), flush=True)


def summarize(values):
    if not values:
        return None
    values = sorted(values)

    def at(q):
        index = (len(values) - 1) * q
        low = int(index)
        high = min(low + 1, len(values) - 1)
        return values[low] + (values[high] - values[low]) * (index - low)

    return {"p50": at(.5), "p95": at(.95)}


def client(args):
    frames = [file.read_bytes() for file in sorted(args.images.glob("*.jpg"))]
    if not frames:
        raise ValueError("Provide public JPEGs to upload")
    remote = "bash " + shlex.quote(args.server)
    started = perf_counter()
    proc = subprocess.Popen(["ssh", "-i", str(args.identity), "-p", str(args.port), "-o",
                             "BatchMode=yes", "-o", "IdentitiesOnly=yes", args.host, remote],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    ready = json.loads(proc.stdout.readline())
    if not ready.get("ready"):
        raise RuntimeError("Public service did not initialize")
    startup = (perf_counter() - started) * 1000

    def exchange(payload):
        sent = perf_counter()
        proc.stdin.write(HEADER.pack(len(payload)))
        proc.stdin.write(payload)
        proc.stdin.flush()
        reply = json.loads(proc.stdout.readline())
        received = perf_counter()
        return sent, received, reply

    for payload in frames[:min(5, len(frames))]:
        exchange(payload)

    condition = Condition()
    results = []
    pending = None
    stopped = False
    dropped = 0

    def sender():
        nonlocal pending
        while True:
            with condition:
                condition.wait_for(lambda: stopped or pending is not None)
                if pending is None and stopped:
                    return
                tick, payload = pending
                pending = None
            sent, received, reply = exchange(payload)
            server_ms = reply["service_ms"]
            results.append({
                "age_ms": (received - tick) * 1000, "queue_ms": (sent - tick) * 1000,
                "network_residual_ms": (received - sent) * 1000 - server_ms,
                "rtt_ms": (received - sent) * 1000, "service_ms": server_ms,
                "model_ms": reply["model_ms"], "bytes": len(payload),
            })

    thread = Thread(target=sender)
    thread.start()
    start = perf_counter()
    count = round(args.duration * args.rate)
    for i in range(count):
        tick = start + i / args.rate
        delay = tick - perf_counter()
        if delay > 0:
            sleep(delay)
        with condition:
            if pending is not None:
                dropped += 1
            pending = tick, frames[i % len(frames)]
            condition.notify()
    with condition:
        stopped = True
        condition.notify()
    thread.join()
    elapsed = perf_counter() - start
    proc.stdin.write(HEADER.pack(0))
    proc.stdin.close()
    if proc.wait():
        raise RuntimeError("Remote process exited with an error")
    if len(results) + dropped != count:
        raise RuntimeError("Upload queue lost accounting")
    summary = {field: summarize([row[field] for row in results]) for field in results[0]}
    summary.update(startup_ms=startup, offered=count, dropped=dropped, delivered=len(results),
                   delivered_hz=len(results) / elapsed)
    args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    remote = commands.add_parser("server")
    remote.add_argument("upstream", type=Path)
    local = commands.add_parser("client")
    local.add_argument("--images", type=Path, required=True)
    local.add_argument("--identity", type=Path, required=True)
    local.add_argument("--host", required=True)
    local.add_argument("--port", type=int, required=True)
    local.add_argument("--server", required=True)
    local.add_argument("--duration", type=float, default=15)
    local.add_argument("--rate", type=float, default=20)
    local.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    server(args.upstream) if args.mode == "server" else client(args)


if __name__ == "__main__":
    main()
